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
    (
        "/api/vault/pages/by-id/{uuid}/properties",
        "get",
    ),
    ("/api/vault/bases/{slug}/views/{view}/evaluate", "post"),
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
        operation_count, 109,
        "OpenAPI should document all 109 registered /api/vault operations"
    );
}

#[test]
fn openapi_defines_the_page_base_property_projection_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let operation =
        &document["paths"]["/api/vault/pages/by-id/{uuid}/properties"]["get"];
    assert_eq!(operation["operationId"], "get_page_base_properties");
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/PageBasePropertiesResponse"
    );
    for status in ["400", "404", "500"] {
        assert_eq!(
            operation["responses"][status]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/ApiError",
            "missing ApiError response schema for {status}"
        );
    }

    let schemas = &document["components"]["schemas"];
    assert_eq!(
        schemas["PagePropertyCompatibility"]["enum"],
        serde_json::json!(["compatible", "conflict"])
    );
    assert_eq!(
        schemas["PagePropertyBlocker"]["enum"],
        serde_json::json!(["schema_conflict", "reserved_key"])
    );
    assert_eq!(
        schemas["PagePropertyDeclaration"]["properties"]["base"]["$ref"],
        "#/components/schemas/PageBaseIdentity"
    );
    assert_eq!(
        schemas["PagePropertyDeclaration"]["properties"]["definition"]["$ref"],
        "#/components/schemas/PropertyDefinition"
    );
    assert_eq!(
        schemas["PageBaseProperty"]["properties"]["compatibility"]["$ref"],
        "#/components/schemas/PagePropertyCompatibility"
    );
    assert_eq!(
        schemas["PageBaseProperty"]["properties"]["declarations"]["items"]["$ref"],
        "#/components/schemas/PagePropertyDeclaration"
    );
    assert_eq!(
        schemas["PageBaseProperty"]["properties"]["blockers"]["items"]["$ref"],
        "#/components/schemas/PagePropertyBlocker"
    );
    assert_eq!(
        schemas["PageBasePropertiesResponse"]["properties"]["matching_bases"]["items"]["$ref"],
        "#/components/schemas/PageBaseIdentity"
    );
    assert_eq!(
        schemas["PageBasePropertiesResponse"]["properties"]["properties"]["items"]["$ref"],
        "#/components/schemas/PageBaseProperty"
    );
}

#[test]
fn openapi_kind_enum_contains_recipe() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let kinds = document["components"]["schemas"]["Kind"]["enum"]
        .as_array()
        .expect("Kind should be a string enum");
    assert!(kinds.contains(&serde_json::json!("RECIPE")));
}

#[test]
fn openapi_contract_defines_the_embedded_base_evaluation_wire_shape() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let operation = &document["paths"]["/api/vault/bases/{slug}/views/{view}/evaluate"]["post"];
    assert_eq!(operation["operationId"], "evaluate_embedded_view");
    assert_eq!(
        operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/BaseViewEvaluateRequest"
    );
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/BaseViewEvaluateResponse"
    );
    for status in ["400", "404", "409", "500"] {
        assert_eq!(
            operation["responses"][status]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/ApiError",
            "missing ApiError response schema for {status}"
        );
    }

    let schemas = &document["components"]["schemas"];
    let request = &schemas["BaseViewEvaluateRequest"];
    assert_eq!(
        request["properties"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["filter", "limit", "sort"]
    );
    assert_eq!(
        request["properties"]["filter"]["oneOf"],
        serde_json::json!([
            { "type": "null" },
            { "$ref": "#/components/schemas/Filter" }
        ])
    );
    assert_eq!(
        request["properties"]["sort"]["type"],
        serde_json::json!(["array", "null"])
    );
    assert_eq!(
        request["properties"]["sort"]["items"]["$ref"],
        "#/components/schemas/SortKey"
    );
    assert_eq!(request["properties"]["sort"]["maxItems"], 8);
    assert_eq!(
        request["properties"]["limit"]["type"],
        serde_json::json!(["integer", "null"])
    );
    assert_eq!(request["properties"]["limit"]["format"], "int32");
    assert_eq!(request["properties"]["limit"]["minimum"], 1);
    assert_eq!(request["properties"]["limit"]["maximum"], 200);
    assert!(request.get("required").is_none());

    let response = &schemas["BaseViewEvaluateResponse"];
    assert_eq!(
        response["required"],
        serde_json::json!(["output", "revision", "member_creation"])
    );
    assert_eq!(
        response["properties"]["output"]["$ref"],
        "#/components/schemas/QueryOutput"
    );
    assert_eq!(
        response["properties"]["member_creation"]["$ref"],
        "#/components/schemas/BaseMemberCapability"
    );
    assert_eq!(response["properties"]["revision"]["type"], "string");

    let filter = &schemas["Filter"];
    for branch in filter["oneOf"].as_array().unwrap() {
        if let Some(all) = branch["properties"].get("all") {
            assert_eq!(all["items"]["$ref"], "#/components/schemas/Filter");
        }
        if let Some(any) = branch["properties"].get("any") {
            assert_eq!(any["items"]["$ref"], "#/components/schemas/Filter");
        }
        if let Some(not) = branch["properties"].get("not") {
            assert_eq!(not["$ref"], "#/components/schemas/Filter");
        }
    }
    assert_eq!(
        schemas["SortKey"]["properties"]["dir"]["$ref"],
        "#/components/schemas/SortDir"
    );
    assert!(
        schemas["BaseMemberScope"]["enum"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("embed"))
    );
    assert_eq!(
        schemas["BaseMemberFieldRequirement"]["properties"]["embed"]["type"],
        "boolean"
    );
    assert!(
        schemas["BaseMemberFieldRequirement"]["required"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("embed"))
    );
}
