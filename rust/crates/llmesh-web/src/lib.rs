#![forbid(unsafe_code)]
//! Browser boundary for portable contracts. No native daemon or engine dependencies.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub fn quote_json(input: &str) -> Result<String, String> {
    if input.len() > 524_288 {
        return Err("Input exceeds 512 KiB".into());
    }
    let input = serde_json::from_str(input).map_err(|error| error.to_string())?;
    let quote = llmesh_proto::quote_work(&input)?;
    serde_json::to_string(&quote).map_err(|error| error.to_string())
}

pub fn placement_json(input: &str) -> Result<String, String> {
    if input.len() > 524_288 {
        return Err("Input exceeds 512 KiB".into());
    }
    let input: serde_json::Value =
        serde_json::from_str(input).map_err(|error| error.to_string())?;
    let plan = llmesh_hw::plan_placement(&input["hardware"], &input["options"])?;
    serde_json::to_string(&plan).map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = planPlacement)]
pub fn plan_placement(input: &str) -> Result<String, JsValue> {
    placement_json(input).map_err(|error| JsValue::from_str(&error))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = quoteWork)]
pub fn quote_work(input: &str) -> Result<String, JsValue> {
    quote_json(input).map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    #[test]
    fn boundary_rejects_invalid_input() {
        assert!(super::quote_json("{}").is_err());
        assert!(super::quote_json(&"x".repeat(524_289)).is_err());
    }
}
