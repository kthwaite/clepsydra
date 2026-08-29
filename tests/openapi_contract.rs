use clepsydra::FeatureFlags;
use clepsydra::api::openapi::{self, ApiDoc};
use utoipa::OpenApi;

const VAULT_OPERATIONS: &[(&str, &str)] = &[
    ("/api/vault/archive", "post"),
    ("/api/vault/archive/view/{snapshot_hash}", "get"),
    ("/api/vault/archive/view/{snapshot_hash}", "head"),
    ("/api/vault/archive/status", "get"),
    ("/api/vault/cas/{hash}", "get"),
    ("/api/vault/journal/today", "get"),
    ("/api/vault/journal/today", "post"),
    ("/api/vault/journal/today/capture", "post"),
    ("/api/vault/journal/range", "get"),
    ("/api/vault/journal/recent", "get"),
    ("/api/vault/journal/{date}", "get"),
    ("/api/vault/ai-journal/today", "get"),
    ("/api/vault/ai-journal/today", "post"),
    ("/api/vault/ai-journal/today/capture", "post"),
    ("/api/vault/ai-journal/range", "get"),
    ("/api/vault/ai-journal/recent", "get"),
    ("/api/vault/ai-journal/{date}", "get"),
    ("/api/vault/conversations/capture", "post"),
    ("/api/vault/tasks", "get"),
    ("/api/vault/tasks/history", "get"),
    ("/api/vault/tasks/status", "put"),
    ("/api/vault/agenda", "get"),
    ("/api/vault/agenda/cycle-burndown", "get"),
    ("/api/vault/blocks/search", "get"),
    ("/api/vault/blocks/assign-id", "post"),
    ("/api/vault/blocks/{block_id}", "get"),
    ("/api/vault/pages/by-id/{uuid}/properties", "get"),
    ("/api/vault/bases/{slug}/views/{view}/evaluate", "post"),
    ("/api/vault/rubbish", "get"),
    ("/api/vault/rubbish", "delete"),
    ("/api/vault/rubbish/{item_id}", "get"),
    ("/api/vault/rubbish/{item_id}", "delete"),
    ("/api/vault/rubbish/{item_id}/restore", "post"),
    ("/api/vault/sync", "post"),
    ("/api/vault/sync/status", "get"),
    ("/api/vault/sync/conflicts", "get"),
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
            ["get", "post", "put", "patch", "delete", "head"]
                .iter()
                .filter(|method| item.get(**method).is_some())
                .count()
        })
        .sum::<usize>();
    assert_eq!(
        operation_count, 124,
        "OpenAPI should document all 124 registered /api/vault operations"
    );
}

#[test]
fn openapi_defines_consolidated_agenda_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let paths = document["paths"]
        .as_object()
        .expect("OpenAPI paths should be an object");
    let operation = &paths["/api/vault/agenda"]["get"];
    let parameters = operation["parameters"]
        .as_array()
        .expect("Agenda parameters should be an array");

    assert!(parameters.iter().any(|parameter| {
        parameter["name"] == "today" && parameter["in"] == "query" && parameter["required"] == true
    }));
    let mut agenda_paths = paths
        .keys()
        .filter(|path| path.starts_with("/api/vault/agenda"))
        .map(String::as_str)
        .collect::<Vec<_>>();
    agenda_paths.sort_unstable();
    assert_eq!(
        agenda_paths,
        ["/api/vault/agenda", "/api/vault/agenda/cycle-burndown"]
    );

    let schemas = document["components"]["schemas"]
        .as_object()
        .expect("OpenAPI schemas should be an object");
    for schema in [
        "AgendaResponse",
        "AgendaDay",
        "AgendaItem",
        "AgendaTodo",
        "AgendaTask",
        "AgendaTodoKind",
        "AgendaTaskKind",
        "AgendaTodoStatus",
        "AgendaTaskStatus",
        "AgendaTaskPriority",
    ] {
        assert!(schemas.contains_key(schema), "missing {schema} schema");
    }

    assert_eq!(
        schemas["AgendaTodoKind"]["enum"],
        serde_json::json!(["todo"])
    );
    assert_eq!(
        schemas["AgendaTaskKind"]["enum"],
        serde_json::json!(["task"])
    );
    assert_eq!(
        schemas["AgendaTodoStatus"]["enum"],
        serde_json::json!(["todo", "doing"])
    );
    assert_eq!(
        schemas["AgendaTaskStatus"]["enum"],
        serde_json::json!(["INTAKE", "TRIAGE", "FIELD", "REVIEW"])
    );
    assert_eq!(
        schemas["AgendaTaskPriority"]["enum"],
        serde_json::json!(["P0", "P1", "P2", "P3"])
    );

    assert_eq!(
        schemas["AgendaResponse"]["properties"]["undated"]["items"]["$ref"],
        "#/components/schemas/AgendaTodo"
    );
    assert_eq!(
        schemas["AgendaItem"]["discriminator"]["propertyName"],
        "kind"
    );
    assert_eq!(
        schemas["AgendaItem"]["discriminator"]["mapping"],
        serde_json::json!({
            "todo": "#/components/schemas/AgendaTodo",
            "task": "#/components/schemas/AgendaTask"
        })
    );
    let agenda_item_variants = schemas["AgendaItem"]["oneOf"]
        .as_array()
        .expect("AgendaItem should be a discriminated union")
        .iter()
        .map(|variant| {
            variant["$ref"]
                .as_str()
                .expect("variant should be a schema ref")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        agenda_item_variants,
        [
            "#/components/schemas/AgendaTodo",
            "#/components/schemas/AgendaTask"
        ]
    );
}

#[test]
fn openapi_defines_the_archive_view_get_resource_diagnostic() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let operation = &document["paths"]["/api/vault/archive/view/{snapshot_hash}"]["get"];

    assert_eq!(
        operation["responses"]["200"]["headers"]["X-Clepsydra-Archive-Uncaptured-Resource-Count"]["schema"]
            ["type"],
        "integer"
    );
}

#[test]
fn openapi_defines_the_archive_view_head_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let operation = &document["paths"]["/api/vault/archive/view/{snapshot_hash}"]["head"];

    assert!(
        operation.is_object(),
        "archive snapshot HEAD is undocumented"
    );
    for status in ["200", "404", "415", "500"] {
        assert!(
            operation["responses"][status].is_object(),
            "archive snapshot HEAD response {status} is undocumented"
        );
    }
    assert_eq!(
        operation["responses"]["415"]["headers"]["X-Clepsydra-Archive-Content-Type"]["schema"]["type"],
        "string"
    );
    assert_eq!(
        operation["responses"]["200"]["headers"]["X-Clepsydra-Archive-Uncaptured-Resource-Count"]["schema"]
            ["type"],
        "integer"
    );
    assert_eq!(
        operation["responses"]["500"]["headers"]["X-Clepsydra-Archive-Diagnostic"]["schema"]["type"],
        "string"
    );
}

#[test]
fn openapi_defines_the_page_base_property_projection_contract() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let operation = &document["paths"]["/api/vault/pages/by-id/{uuid}/properties"]["get"];
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
    let page_base_property = &schemas["PageBaseProperty"];
    let required = page_base_property["required"]
        .as_array()
        .expect("PageBaseProperty.required should be an array");
    for field in ["value", "definition"] {
        assert!(
            required.contains(&serde_json::json!(field)),
            "PageBaseProperty.{field} is always serialized and must be required"
        );
    }
    let value_schema = &page_base_property["properties"]["value"];
    assert!(
        value_schema.get("type").is_none(),
        "the unconstrained PageBaseProperty.value schema must permit JSON null"
    );
    let definition_variants = page_base_property["properties"]["definition"]["oneOf"]
        .as_array()
        .expect("PageBaseProperty.definition should be a nullable oneOf");
    assert!(
        definition_variants
            .iter()
            .any(|variant| variant["type"] == "null"),
        "PageBaseProperty.definition must permit null"
    );
    assert!(
        definition_variants
            .iter()
            .any(|variant| variant["$ref"] == "#/components/schemas/PropertyDefinition"),
        "PageBaseProperty.definition must reference PropertyDefinition"
    );
    assert_eq!(
        page_base_property["properties"]["compatibility"]["$ref"],
        "#/components/schemas/PagePropertyCompatibility"
    );
    assert_eq!(
        page_base_property["properties"]["declarations"]["items"]["$ref"],
        "#/components/schemas/PagePropertyDeclaration"
    );
    assert_eq!(
        page_base_property["properties"]["blockers"]["items"]["$ref"],
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
fn openapi_kind_enum_contains_meeting_but_not_the_retired_one_on_one() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let kinds = document["components"]["schemas"]["Kind"]["enum"]
        .as_array()
        .expect("Kind should be a string enum");
    assert!(kinds.contains(&serde_json::json!("MEETING")));
    // ONE_ON_ONE folded into MEETING (+ tag `1:1`) on 2026-08-28; the wire
    // vocabulary must not advertise it, even though the server still reads it.
    assert!(!kinds.contains(&serde_json::json!("ONE_ON_ONE")));
}

#[test]
fn openapi_kind_enum_contains_ai_journal() {
    let document = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI should serialize");
    let kinds = document["components"]["schemas"]["Kind"]["enum"]
        .as_array()
        .expect("Kind should be a string enum");
    assert!(kinds.contains(&serde_json::json!("AI_JOURNAL")));
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
        vec!["filter", "group_by", "limit", "offset", "sort"]
    );
    assert_eq!(
        request["properties"]["filter"]["oneOf"],
        serde_json::json!([
            { "type": "null" },
            { "$ref": "#/components/schemas/Filter" }
        ])
    );
    assert_eq!(
        request["properties"]["group_by"]["type"],
        serde_json::json!(["string", "null"])
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
    // The row window: flat views walk a large result with this.
    assert_eq!(
        request["properties"]["offset"]["type"],
        serde_json::json!(["integer", "null"])
    );
    assert_eq!(request["properties"]["offset"]["format"], "int32");
    assert_eq!(request["properties"]["offset"]["minimum"], 0);
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

#[test]
fn runtime_openapi_filters_disabled_features_without_narrowing_static_document() {
    for features in [
        FeatureFlags {
            academic: false,
            feeds: false,
        },
        FeatureFlags {
            academic: true,
            feeds: false,
        },
        FeatureFlags {
            academic: false,
            feeds: true,
        },
        FeatureFlags {
            academic: true,
            feeds: true,
        },
    ] {
        let runtime = serde_json::to_value(openapi::document(features))
            .expect("runtime OpenAPI should serialize");
        let paths = runtime["paths"]
            .as_object()
            .expect("runtime OpenAPI paths should be an object");
        let tags = runtime["tags"]
            .as_array()
            .expect("runtime OpenAPI tags should be an array");

        assert!(paths.contains_key("/api/features"));
        assert_eq!(
            paths
                .keys()
                .any(|path| path.starts_with("/api/vault/academic")),
            features.academic
        );
        assert_eq!(
            paths
                .keys()
                .any(|path| path.starts_with("/api/vault/feeds")),
            features.feeds
        );
        assert_eq!(
            tags.iter().any(|tag| tag["name"] == "Academic"),
            features.academic
        );
        assert_eq!(
            tags.iter().any(|tag| tag["name"] == "Feeds"),
            features.feeds
        );
    }

    let complete = ApiDoc::openapi();
    assert!(complete.paths.paths.contains_key("/api/features"));
    assert!(
        complete
            .paths
            .paths
            .contains_key("/api/vault/academic/works")
    );
    assert!(complete.paths.paths.contains_key("/api/vault/feeds"));
}
