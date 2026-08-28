//! Print the OpenAPI document without starting a server, so the UI's
//! `schema.d.ts` can be regenerated from a build of this exact checkout:
//!
//! ```sh
//! cargo run -q --example openapi > target/openapi.json && (cd ui && bun run openapi:file)
//! ```
use utoipa::OpenApi;

fn main() {
    let json = clepsydra::api::openapi::ApiDoc::openapi()
        .to_pretty_json()
        .expect("OpenAPI document serializes");
    println!("{json}");
}
