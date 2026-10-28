#![forbid(unsafe_code)]

use std::io::{self, Read};

#[cfg(all(feature = "community", feature = "sovereign"))]
compile_error!("Select community or sovereign, never both; sovereign needs --no-default-features");

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "version") => {
            println!("llmesh {} (Rust preview)", env!("CARGO_PKG_VERSION"));
        }
        Some("quote") => {
            let mut data = String::new();
            io::stdin()
                .take(524_289)
                .read_to_string(&mut data)
                .map_err(|error| error.to_string())?;
            if data.len() > 524_288 {
                return Err("Input exceeds 512 KiB".into());
            }
            let input = serde_json::from_str(&data).map_err(|error| error.to_string())?;
            let quote = llmesh_proto::quote_work(&input)?;
            println!(
                "{}",
                serde_json::to_string(&quote).map_err(|e| e.to_string())?
            );
        }
        Some("--help" | "help") | None => {
            println!("Rust foundation preview: llmesh --version | quote < request.json");
            println!("Inference, mesh, wallet and account pairing still use the Node app.");
        }
        _ => return Err("Not implemented in Rust yet; use the Node CLI".into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
