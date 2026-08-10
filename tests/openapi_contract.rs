use clepsydra::api::openapi::ApiDoc;
use utoipa::OpenApi;

const VAULT_OPERATIONS: &[(&str, &str)] = &[
    ("/api/vault/archive", "post"),
    ("/api/vault/archive/status", "get"),
    ("/api/vault/cas/{hash}", "get"),
    ("/api/vault/journal/today", "get"),
    ("/api/vault/journal/today", "post"),
    ("/api/vault/journal/today/capture", "post"),
    ("/api/vault/journal/range", "get"),
    ("/api/vault/journal/recent", "get"),
    ("/api/vault/journal/{date}", "get"),
    ("/api/vault/conversations/capture", "post"),
    ("/api/vault/tasks", "get"),
    ("/api/vault/tasks/history", "get"),
    ("/api/vault/tasks/status", "put"),
    ("/api/vault/agenda/today", "get"),
    ("/api/vault/agenda/week", "get"),
    ("/api/vault/agenda/overdue", "get"),
    ("/api/vault/agenda/cycle-burndown", "get"),
    ("/api/vault/blocks/search", "get"),
    ("/api/vault/blocks/assign-id", "post"),
    ("/api/vault/blocks/{block_id}", "get"),
];

#[test]
fn openapi_documents_every_registered_vault_operation() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let paths = document["paths"]
        .as_object()
        .expect("OpenAPI paths should be an object");

    let missing: Vec<String> = VAULT_OPERATIONS
        .iter()
        .filter(|(path, method)| {
            paths
                .get(*path)
                .and_then(|item| item.get(*method))
                .is_none()
        })
        .map(|(path, method)| format!("{method:>6} {path}"))
        .collect();
    assert!(
        missing.is_empty(),
        "registered vault operations missing from OpenAPI:\n{}",
        missing.join("\n")
    );

    let operation_count = paths
        .iter()
        .filter(|(path, _)| path.starts_with("/api/vault"))
        .map(|(_, item)| {
            ["get", "post", "put", "patch", "delete"]
                .iter()
                .filter(|method| item.get(**method).is_some())
                .count()
        })
        .sum::<usize>();
    assert_eq!(
        operation_count, 103,
        "OpenAPI should document all 103 registered /api/vault operations"
    );
}
