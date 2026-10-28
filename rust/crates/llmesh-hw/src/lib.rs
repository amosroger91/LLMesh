#![forbid(unsafe_code)]
//! Pure placement planner. Native hardware probes are added separately.

use serde_json::{Value, json};

const MEMORY_FACTOR: f64 = 0.8;

#[derive(Clone)]
struct Gpu {
    uuid: String,
    index: u64,
    backend: String,
    budget: f64,
}

fn number(value: &Value, field: &str) -> Result<f64, String> {
    value[field]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| format!("Invalid {field}"))
}

fn fitting(models: &[Value], ram: f64, budget: f64, cpu: bool, level: &str) -> Vec<Value> {
    let limit = match level {
        "low" => 2.0,
        "medium" => 4.0,
        _ => f64::INFINITY,
    };
    models
        .iter()
        .filter(|m| {
            m["minRamGB"].as_f64().unwrap_or(f64::INFINITY) <= ram
                && m["memoryGB"].as_f64().unwrap_or(f64::INFINITY) * MEMORY_FACTOR <= budget
                && (!cpu || m["parametersB"].as_f64().unwrap_or(f64::INFINITY) <= limit)
        })
        .cloned()
        .collect()
}

struct Planner {
    models: Vec<Value>,
    ram: f64,
    level: String,
    parallel: u64,
    base_port: u64,
    threads: u64,
    keep_alive: &'static str,
    batch: u32,
    instances: Vec<Value>,
    warnings: Vec<String>,
}

impl Planner {
    fn add(&mut self, gpus: &[Gpu], backend: &str, budget: f64, kind: &str, cpu: bool) {
        let mut candidates = fitting(&self.models, self.ram, budget, cpu, &self.level);
        let Some(model) = candidates.last().cloned() else {
            return;
        };
        let parallel = if model["id"].as_str().unwrap_or("").starts_with("qwen3.5:") {
            1
        } else {
            self.parallel
        };
        if parallel != self.parallel {
            let warning = format!(
                "{}: pinned Ollama limits this architecture to one slot per instance",
                model["id"].as_str().unwrap_or("")
            );
            if !self.warnings.contains(&warning) {
                self.warnings.push(warning);
            }
        }
        candidates.reverse();
        let index = self.instances.len();
        self.instances.push(json!({
            "id": format!("instance-{index}"), "gpus": gpus.iter().map(|g| &g.uuid).collect::<Vec<_>>(),
            "gpuIndexes":gpus.iter().map(|g|g.index).collect::<Vec<_>>(),"backend":backend,
            "model":model,"candidates":candidates,"port":self.base_port+index as u64,
            "parallel":parallel,"requestedParallel":self.parallel,"mode":kind,"memoryBudgetGB":budget,
            "threads":self.threads,"keepAlive":self.keep_alive,"batch":self.batch
        }));
    }
}

pub fn plan_placement(hardware: &Value, options: &Value) -> Result<Value, String> {
    let level = options["level"].as_str().unwrap_or("medium");
    let (fraction, thread_fraction, keep_alive, batch) = match level {
        "low" => (0.35, 0.25, "5m", 64),
        "medium" => (0.75, 0.5, "15m", 128),
        "high" => (1.0, 1.0, "30m", 512),
        _ => return Err("Choose low, medium, or high contribution".into()),
    };
    let mode = options["mode"].as_str().unwrap_or("auto");
    if !["auto", "split", "replicate"].contains(&mode) {
        return Err("Placement must be auto, split, or replicate".into());
    }
    let parallel = options
        .get("parallel")
        .unwrap_or(&Value::from(1))
        .as_u64()
        .filter(|n| (1..=4).contains(n))
        .ok_or("parallel must be 1–4")?;
    let selection = options
        .get("gpuSelection")
        .cloned()
        .unwrap_or(json!("auto"));
    if selection != "auto" && selection != "all" && !selection.is_array() {
        return Err("gpus must be auto, all, or an array of GPU IDs".into());
    }
    let total_ram = number(hardware, "ramGB")?;
    let ram = total_ram.min(number(hardware, "freeRamGB")?);
    let mut models = options
        .get("catalog")
        .unwrap_or(&Value::Null)
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            serde_json::from_str::<Value>(include_str!("../../../../models/catalog.json"))
                .expect("embedded catalog")["models"]
                .as_array()
                .expect("models")
                .clone()
        });
    models.sort_by_key(|m| m["rank"].as_i64().unwrap_or(0));
    let cores = hardware["physicalCores"]
        .as_f64()
        .or_else(|| hardware["cores"].as_f64())
        .unwrap_or(1.0);
    let mut planner = Planner {
        models,
        ram: total_ram,
        level: level.into(),
        parallel,
        base_port: options["basePort"].as_u64().unwrap_or(11500),
        threads: (cores * thread_fraction).floor().max(1.0) as u64,
        keep_alive,
        batch,
        instances: vec![],
        warnings: vec![],
    };
    if hardware["unifiedMemory"] == true {
        planner.add(
            &[],
            "metal",
            (ram - 2.0).max(0.0) * fraction,
            "single",
            false,
        );
    } else {
        let source = hardware["gpus"].as_array().ok_or("gpus must be an array")?;
        let mut gpus = Vec::new();
        let mut missing = selection.as_array().cloned().unwrap_or_default();
        for (position, gpu) in source.iter().enumerate() {
            let index = gpu["index"].as_u64().unwrap_or(position as u64);
            let uuid = gpu["uuid"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("gpu-{index}"));
            let matches_id = |id: &Value| {
                id.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.to_string())
                    == uuid
                    || id
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| id.to_string())
                        == index.to_string()
            };
            missing.retain(|id| !matches_id(id));
            let name = gpu["name"].as_str().unwrap_or("").to_lowercase();
            let vram = number(gpu, "vramGB")?;
            if let Some(ids) = selection.as_array() {
                if !ids.iter().any(matches_id) {
                    continue;
                }
            } else if selection == "auto"
                && (gpu["integrated"] == true
                    || name
                        .split(|c: char| !c.is_alphanumeric())
                        .any(|word| ["uhd", "iris", "apu"].contains(&word))
                    || vram < 2.0)
            {
                continue;
            }
            let vendor = gpu["vendor"].as_str().unwrap_or(&name).to_lowercase();
            let backend = gpu["backend"]
                .as_str()
                .unwrap_or(if vendor.contains("nvidia") {
                    "cuda"
                } else if vendor.contains("amd") || vendor.contains("radeon") {
                    "rocm"
                } else {
                    "vulkan"
                })
                .to_owned();
            let reserve = if hardware["platform"] == "win32"
                && selection == "auto"
                && index == options["displayGpu"].as_u64().unwrap_or(0)
            {
                1.5
            } else {
                0.0
            };
            let free = gpu["freeGB"].as_f64().unwrap_or(vram);
            if !free.is_finite() || free < 0.0 {
                return Err("Invalid freeGB".into());
            }
            gpus.push(Gpu {
                uuid,
                index,
                backend,
                budget: (free - 0.75 * parallel as f64 - reserve).max(0.0) * fraction,
            });
        }
        if !missing.is_empty() {
            return Err(format!(
                "Unknown GPU selection: {}",
                missing
                    .iter()
                    .map(|v| v
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        gpus.sort_by(|a, b| b.budget.total_cmp(&a.budget).then(a.uuid.cmp(&b.uuid)));
        if level == "low" {
            gpus.truncate(1);
        }
        let mut backends: Vec<String> = Vec::new();
        for gpu in &gpus {
            if !backends.contains(&gpu.backend) {
                backends.push(gpu.backend.clone());
            }
        }
        for backend in backends {
            let group: Vec<Gpu> = gpus
                .iter()
                .filter(|g| g.backend == backend)
                .cloned()
                .collect();
            let largest = fitting(
                &planner.models,
                total_ram,
                group.iter().map(|g| g.budget).sum(),
                false,
                level,
            )
            .last()
            .cloned();
            let single = fitting(&planner.models, total_ram, group[0].budget, false, level)
                .last()
                .cloned();
            if group.len() > 1
                && largest.is_some()
                && mode != "replicate"
                && (mode == "split"
                    || largest
                        .as_ref()
                        .and_then(|m| m["rank"].as_i64())
                        .unwrap_or(0)
                        > single
                            .as_ref()
                            .and_then(|m| m["rank"].as_i64())
                            .unwrap_or(0))
            {
                let target = largest
                    .as_ref()
                    .and_then(|m| m["memoryGB"].as_f64())
                    .unwrap_or(f64::INFINITY)
                    * MEMORY_FACTOR;
                let mut budget = 0.0;
                let mut count = 0;
                for gpu in &group {
                    budget += gpu.budget;
                    count += 1;
                    if mode != "split" && budget >= target {
                        break;
                    }
                }
                planner.add(&group[..count], &backend, budget, "split", false);
                for gpu in &group[count..] {
                    planner.add(
                        std::slice::from_ref(gpu),
                        &backend,
                        gpu.budget,
                        "single",
                        false,
                    );
                }
            } else {
                for gpu in &group {
                    planner.add(
                        std::slice::from_ref(gpu),
                        &backend,
                        gpu.budget,
                        "single",
                        false,
                    );
                }
            }
        }
        if planner.instances.is_empty()
            && (selection == "auto"
                || selection == "all"
                || selection.as_array().is_some_and(Vec::is_empty))
        {
            planner.add(&[], "cpu", (ram - 1.0).max(0.0) * fraction, "cpu", true);
        }
    }
    let count = planner.instances.len();
    let reason = if count > 0 {
        let descriptions = planner
            .instances
            .iter()
            .map(|instance| {
                format!(
                    "{} ({}, {} devices)",
                    instance["model"]["id"].as_str().unwrap_or(""),
                    instance["mode"].as_str().unwrap_or(""),
                    if instance["gpus"].as_array().is_none_or(Vec::is_empty) {
                        "CPU/unified".into()
                    } else {
                        instance["gpus"].as_array().map_or(0, Vec::len).to_string()
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        format!(
            "{count} runtime instance{}: {descriptions}",
            if count == 1 { "" } else { "s" }
        )
    } else {
        format!(
            "No model fits current budgets: {ram:.1} GB free RAM. Free memory or lower parallelism."
        )
    };
    Ok(
        json!({"level":level,"mode":mode,"gpuSelection":selection,"instances":planner.instances,"warnings":planner.warnings,"reason":reason}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn equivalent(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b)))
            }
            _ => a == b,
        }
    }

    #[test]
    fn shared_placement_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../../fixtures/placement.json"))
                .expect("fixtures");
        for case in cases {
            let result = plan_placement(&case["hardware"], &case["options"]);
            if case["error"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                let actual = result.expect("valid placement");
                assert!(
                    equivalent(&actual, &case["expected"]),
                    "{}\nactual={actual}\nexpected={}",
                    case["name"],
                    case["expected"]
                );
            }
        }
    }
}
