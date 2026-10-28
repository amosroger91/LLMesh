#![forbid(unsafe_code)]
//! Portable contracts shared by native and WASM clients. Not a daemon implementation.

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

pub const QUOTE_BASIS: &str = "Fixed completion quote by model size, input characters and reserved output budget; not actual-token metering";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub parameters_b: f64,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    pub model: Model,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default = "default_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub tools: Vec<Value>,
}

fn default_tokens() -> u32 {
    512
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub version: &'static str,
    pub price_units: u32,
    #[serde(serialize_with = "serialize_js_number")]
    pub parameters_b: f64,
    pub max_tokens: u32,
    pub input_characters: usize,
    pub basis: &'static str,
}

fn serialize_js_number<S: Serializer>(number: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if number.fract() == 0.0 && *number >= 0.0 && *number <= 9_007_199_254_740_991.0 {
        serializer.serialize_u64(*number as u64)
    } else {
        serializer.serialize_f64(*number)
    }
}

/// Counts JavaScript UTF-16 code units, including two units for astral characters.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn quote_work(input: &QuoteInput) -> Result<Quote, &'static str> {
    let parameters = input.model.parameters_b;
    if !parameters.is_finite() || parameters <= 0.0 || !(1..=2048).contains(&input.max_tokens) {
        return Err("Cannot quote unknown model or output budget");
    }
    let mut characters: usize = input.messages.iter().map(|m| js_length(&m.content)).sum();
    if !input.tools.is_empty() {
        let tools = serde_json::to_string(&input.tools).map_err(|_| "Invalid tools")?;
        characters += js_length(&tools);
    }
    let model_units = if parameters <= 2.0 {
        1
    } else if parameters <= 9.0 {
        2
    } else {
        3
    };
    Ok(Quote {
        version: "model-budget-v1",
        price_units: 3
            .min(model_units + u32::from(input.max_tokens > 1024) + u32::from(characters > 6000)),
        parameters_b: parameters,
        max_tokens: input.max_tokens,
        input_characters: characters,
        basis: QUOTE_BASIS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_quote_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../../../fixtures/quotes.json"))
                .expect("fixture JSON");
        for case in fixtures {
            let parsed = serde_json::from_value::<QuoteInput>(case["input"].clone());
            let result = parsed
                .map_err(|_| "Invalid input")
                .and_then(|input| quote_work(&input));
            if case["error"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(
                    serde_json::to_value(result.expect("valid quote")).expect("serialize"),
                    case["expected"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
