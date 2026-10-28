#![forbid(unsafe_code)]
//! Portable token-usage billing contracts shared by native and WASM clients.
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, json};
pub const STARTER_CREDITS: u32 = 100_000;
pub const QUOTE_BASIS: &str =
    "Refundable maximum reservation; final credits equal reported input plus generated tokens";
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub parameters_b: f64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    pub model: Model,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default = "default_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub tools: Vec<Value>,
    pub context_tokens: Option<u32>,
}
fn default_tokens() -> u32 {
    512
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub version: &'static str,
    pub price_units: u32,
    pub reserved_credits: u32,
    pub credits_per_token: u32,
    #[serde(serialize_with = "serialize_js_number")]
    pub parameters_b: f64,
    pub max_tokens: u32,
    pub context_tokens: u32,
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
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn quote_work(input: &QuoteInput) -> Result<Quote, &'static str> {
    let parameters = input.model.parameters_b;
    if !parameters.is_finite() || parameters <= 0.0 || !(1..=2048).contains(&input.max_tokens) {
        return Err("Cannot quote unknown model or output budget");
    }
    let serialized = serde_json::to_string(&json!({"messages":input.messages,"tools":input.tools}))
        .map_err(|_| "Invalid input")?;
    let input_characters = js_length(&serialized);
    let context = input.context_tokens.unwrap_or_else(|| {
        (((input_characters as f64 / 3.0 + f64::from(input.max_tokens) + 512.0) / 1024.0).ceil()
            as u32
            * 1024)
            .clamp(4096, 32768)
    });
    if !(4096..=32768).contains(&context) {
        return Err("Invalid context budget");
    }
    let reserved = context + input.max_tokens;
    Ok(Quote {
        version: "token-usage-v1",
        price_units: reserved,
        reserved_credits: reserved,
        credits_per_token: 1,
        parameters_b: parameters,
        max_tokens: input.max_tokens,
        context_tokens: context,
        input_characters,
        basis: QUOTE_BASIS,
    })
}
pub fn usage_credits(prompt: u32, output: u32, reserved: u32) -> Result<u32, &'static str> {
    if prompt > 32768 || output > 2048 || prompt + output > reserved {
        return Err("Invalid or over-budget inference token usage");
    }
    Ok(prompt + output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_quote_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../../fixtures/quotes.json"))
                .expect("fixtures");
        for case in cases {
            let result = serde_json::from_value::<QuoteInput>(case["input"].clone())
                .map_err(|_| "Invalid input")
                .and_then(|input| quote_work(&input));
            if case["error"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(
                    serde_json::to_value(result.expect("quote")).expect("serialize"),
                    case["expected"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn metered_usage() {
        assert_eq!(usage_credits(100, 35, 4096), Ok(135));
        assert_eq!(usage_credits(0, 0, 4096), Ok(0));
        assert!(usage_credits(100, 35, 134).is_err());
        assert!(usage_credits(0, 2049, 4096).is_err());
    }
}
