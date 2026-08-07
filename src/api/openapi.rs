use axum::Router;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

/// OpenAPI document for the clepsydra vault API used by the UI.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "Clepsydra API",
        version = "0.0.0",
        description = "Filesystem-backed personal knowledge management API"
    ),
    tags(
        (name = "Pages", description = "Page CRUD endpoints"),
        (name = "Folders", description = "Folder operations"),
        (name = "Attachments", description = "Attachment upload and retrieval"),
        (name = "Index", description = "Index, graph, tags and search"),
        (name = "Academic", description = "Academic works, annotations and importers"),
        (name = "Events", description = "Server-sent events stream"),
        (name = "BCL", description = "Brimley-Cocoon Line countdown"),
        (name = "Location", description = "Vault geographic location"),
        (name = "Uptime", description = "Server uptime"),
        (name = "Board", description = "TASKING board: read model and task/cycle mutations"),
        (name = "Deeplink", description = "clepsydra:// / obsidian:// deep-link resolution")
    ),
    paths(
        // Pages
        crate::api::pages::list_pages,
        crate::api::pages::create_default_page,
        crate::api::pages::get_page,
        crate::api::pages::get_page_by_id,
        crate::api::pages::update_page_by_id,
        crate::api::pages::protect_page_by_id,
        crate::api::pages::unprotect_page_by_id,
        crate::api::pages::create_page,
        crate::api::pages::update_page,
        crate::api::pages::delete_page,
        crate::api::pages::move_page,
        crate::api::pages::assign_page,
        crate::api::pages::assign_bulk,
        // Encryption keyring
        crate::api::encryption::get_encryption_config,
        crate::api::encryption::setup_encryption,
        crate::api::encryption::rewrap_wrapped_identity,
        // Folders
        crate::api::folders::list_folders,
        crate::api::folders::list_folder_tree,
        crate::api::folders::list_folder_contents,
        crate::api::folders::create_folder,
        crate::api::folders::delete_folder,
        crate::api::folders::move_folder,
        // Attachments
        crate::api::attachments::list_attachments,
        crate::api::attachments::upload_attachment,
        crate::api::attachments::get_attachment,
        crate::api::attachments::delete_attachment,
        // Events
        crate::api::events::event_stream,
        // Index
        crate::api::index_routes::backlinks,
        crate::api::index_routes::outlinks,
        crate::api::index_routes::unresolved,
        crate::api::index_routes::ambiguous,
        crate::api::index_routes::warnings,
        crate::api::index_routes::tags,
        crate::api::index_routes::stats,
        crate::api::index_routes::rebuild_index,
        crate::api::index_routes::create_from_link,
        crate::api::index_routes::preview_mutation,
        crate::api::index_routes::graph,
        crate::api::index_routes::content_index,
        crate::api::index_routes::search,
        crate::api::index_routes::similar,
        // Academic
        crate::api::academic::list_works,
        crate::api::academic::create_work,
        crate::api::academic::get_work,
        crate::api::academic::update_work,
        crate::api::academic::list_annotations,
        crate::api::academic::create_annotation,
        crate::api::academic::import_bibtex,
        crate::api::academic::import_doi,
        crate::api::academic::import_isbn_handler,
        crate::api::academic::import_zotero_handler,
        // BCL
        crate::api::bcl::get_bcl,
        // Location
        crate::api::location::get_location,
        crate::api::location::put_location,
        crate::api::location::geocode_search,
        // Uptime
        crate::api::uptime::get_uptime,
        // Board
        crate::api::board::read::get_board,
        crate::api::board::tasks::create_task,
        crate::api::board::tasks::patch_task,
        crate::api::board::cycles::create_cycle,
        crate::api::board::cycles::patch_cycle,
        // Deeplink
        crate::api::deeplink::resolve_url,
        // Bases
        crate::api::bases::list_bases,
        crate::api::bases::get_base,
        crate::api::bases::evaluate_view,
        crate::api::query::run_query,
        crate::api::properties::patch_properties
    ),
    components(
        schemas(
            // Shared
            crate::api::error::ApiError,
            crate::vault::kind::Kind,
            // Bases
            crate::vault::base::PropertyType,
            crate::vault::base::PropertyDefinition,
            crate::vault::base::Filter,
            crate::vault::base::Op,
            crate::vault::base::SortKey,
            crate::vault::base::SortDir,
            crate::vault::base::Aggregate,
            crate::vault::base::AggregateFn,
            crate::vault::base::ViewDefinition,
            crate::vault::base::BaseFile,
            crate::vault::base::BaseDefinition,
            crate::vault::base::BaseDiagnostic,
            crate::vault::query::QueryRow,
            crate::vault::query::GroupResult,
            crate::vault::query::QueryOutput,
            crate::api::bases::BaseSummary,
            crate::api::bases::BaseListResponse,
            crate::api::bases::BaseDetailResponse,
            crate::api::query::QueryRequest,
            crate::api::properties::PropertyPatchRequest,
            crate::api::properties::PropertyPatchResponse,
            // Pages
            crate::api::pages::PageSummary,
            crate::api::pages::PageMetaResponse,
            crate::api::pages::PageDetailResponse,
            crate::api::pages::PageSummaryListResponse,
            crate::api::pages::CreatePageRequest,
            crate::api::pages::CreateDefaultPageRequest,
            crate::api::pages::UpdatePageRequest,
            crate::api::pages::EncryptionMetaResponse,
            crate::api::pages::ProtectPageRequest,
            crate::api::pages::UnprotectPageRequest,
            crate::api::pages::MovePageRequest,
            crate::api::pages::AssignRequest,
            crate::api::pages::BulkAssignRequest,
            crate::api::pages::BulkAssignResponse,
            crate::api::encryption::EncryptionConfigResponse,
            crate::api::encryption::SetupEncryptionRequest,
            crate::api::encryption::RewrapIdentityRequest,
            // Folders
            crate::api::folders::FolderInfo,
            crate::api::folders::FolderListing,
            crate::api::folders::FolderTreeResponse,
            crate::api::folders::MoveFolderRequest,
            // Attachments
            crate::api::attachments::AttachmentInfo,
            // Events
            crate::api::events::SyncNotification,
            // Index
            crate::api::index_routes::RebuildResponse,
            crate::api::index_routes::OutlinkEntry,
            crate::api::index_routes::UnresolvedLink,
            crate::api::index_routes::CandidateEntry,
            crate::api::index_routes::BacklinkEntry,
            crate::api::index_routes::CreateFromLinkRequest,
            crate::api::index_routes::AmbiguousName,
            crate::api::index_routes::TagCount,
            crate::api::index_routes::VaultStats,
            crate::api::index_routes::GraphResponse,
            crate::api::index_routes::GraphNode,
            crate::api::index_routes::GraphEdge,
            crate::api::index_routes::PreviewMutationRequest,
            crate::api::index_routes::ContentEntry,
            crate::api::index_routes::ContentIndexResponse,
            crate::api::index_routes::SearchResultEntry,
            crate::api::index_routes::SimilarEntry,
            crate::api::index_routes::SimilarResponse,
            // Academic
            crate::api::academic::CreateWorkRequest,
            crate::api::academic::UpdateWorkRequest,
            crate::api::academic::CreateAnnotationRequest,
            crate::api::academic::WorkDetail,
            crate::api::academic::WorkSummary,
            crate::api::academic::WorkSummaryListResponse,
            crate::api::academic::AnnotationDetail,
            crate::api::academic::ImportResult,
            crate::api::academic::ImportResponse,
            crate::api::academic::ImportDoiRequest,
            crate::api::academic::ImportIsbnRequest,
            crate::vault::academic::WorkType,
            crate::vault::academic::ReadingStatus,
            crate::vault::academic::AnnotationType,
            crate::vault::academic::ExternalIds,
            crate::vault::academic::WorkUrls,
            crate::vault::academic::SourceLocation,
            crate::vault::import_zotero::ImportZoteroRequest,
            // BCL
            crate::api::bcl::BclResponse,
            // Location
            crate::api::location::LocationResponse,
            crate::api::location::UpdateLocationRequest,
            crate::api::location::GeocodeResponse,
            crate::api::location::GeocodeResultDto,
            // Uptime
            crate::api::uptime::UptimeResponse,
            // Board
            crate::api::board::BoardResponse,
            crate::api::board::BoardColumn,
            crate::api::board::BoardOperation,
            crate::api::board::BoardCycle,
            crate::api::board::BoardTask,
            crate::api::board::CreateTaskRequest,
            crate::api::board::PatchTaskRequest,
            crate::api::board::CreateCycleRequest,
            crate::api::board::PatchCycleRequest,
            // Deeplink
            crate::api::deeplink::ResolveResponse
        )
    )
)]
pub struct ApiDoc;

/// Routes that expose OpenAPI JSON and Swagger UI.
pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().merge(
        SwaggerUi::new("/api/docs").url("/api/openapi.json", ApiDoc::openapi()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn swagger_is_scoped_under_api_docs() {
        let response = router::<()>()
            .oneshot(
                Request::builder()
                    .uri("/api/docs/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success() || response.status().is_redirection());

        let old = router::<()>()
            .oneshot(
                Request::builder()
                    .uri("/docs/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(old.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn kind_schema_is_the_full_uppercase_vocabulary() {
        // The UI derives its Kind type (and kind dropdowns) from the generated
        // OpenAPI types; this pins the schema to the wire tokens so drift in
        // the rename_all/value_type plumbing fails here, not in the frontend.
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();
        let values = json["components"]["schemas"]["Kind"]["enum"]
            .as_array()
            .expect("Kind schema should be an enum");
        let tokens: Vec<&str> = values.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(
            tokens,
            [
                "NOTE", "PROJECT", "JOURNAL", "TODO", "QUOTE", "BOOK", "CAPTURE", "CODE", "PERSON",
                "TASK", "CYCLE"
            ]
        );
    }

    #[test]
    fn page_detail_revision_is_a_required_string() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();
        let page_detail = &json["components"]["schemas"]["PageDetailResponse"];
        let required = page_detail["required"]
            .as_array()
            .expect("PageDetailResponse.required should be an array");
        assert!(
            required.iter().any(|field| field == "revision"),
            "PageDetailResponse should require revision"
        );
        assert_eq!(
            page_detail["properties"]["revision"]["type"], "string",
            "PageDetailResponse.revision should be a string"
        );
    }

    #[test]
    fn page_update_requires_expected_revision_and_documents_conflicts() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();
        let update_request = &json["components"]["schemas"]["UpdatePageRequest"];
        let required = update_request["required"]
            .as_array()
            .expect("UpdatePageRequest.required should be an array");
        assert!(
            required.iter().any(|field| field == "expected_revision"),
            "UpdatePageRequest should require expected_revision"
        );
        assert_eq!(
            update_request["properties"]["expected_revision"]["type"], "string",
            "UpdatePageRequest.expected_revision should be a string"
        );

        let responses = &json["paths"]["/api/vault/pages/{path}"]["put"]["responses"];
        assert!(
            responses.get("409").is_some(),
            "page update should document revision conflicts"
        );
    }

    #[test]
    fn openapi_documents_mobile_page_operations() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();

        let collection = &json["paths"]["/api/vault/pages"];
        assert!(collection.get("get").is_some());
        assert!(collection.get("post").is_some());

        let by_id = &json["paths"]["/api/vault/pages/by-id/{uuid}"];
        assert!(by_id.get("get").is_some());
        assert!(by_id.get("put").is_some());

        assert!(
            json["components"]["schemas"]
                .get("CreateDefaultPageRequest")
                .is_some()
        );
    }

    #[test]
    fn openapi_includes_core_paths() {
        let spec = ApiDoc::openapi();
        assert!(spec.paths.paths.contains_key("/api/vault/pages"));
        assert!(spec.paths.paths.contains_key("/api/vault/folders/{path}"));
        assert!(spec.paths.paths.contains_key("/api/vault/index/search"));
        assert!(spec.paths.paths.contains_key("/api/vault/academic/works"));
        assert!(
            spec.paths
                .paths
                .contains_key("/api/vault/attachments/{path}")
        );
    }

    #[test]
    fn openapi_includes_board_paths_and_schemas() {
        let spec = ApiDoc::openapi();
        // Board paths
        assert!(
            spec.paths.paths.contains_key("/api/vault/board"),
            "expected /api/vault/board in paths"
        );
        assert!(
            spec.paths.paths.contains_key("/api/vault/board/tasks"),
            "expected /api/vault/board/tasks in paths"
        );
        assert!(
            spec.paths.paths.contains_key("/api/vault/board/tasks/{id}"),
            "expected /api/vault/board/tasks/{{id}} in paths"
        );
        assert!(
            spec.paths.paths.contains_key("/api/vault/board/cycles"),
            "expected /api/vault/board/cycles in paths"
        );
        assert!(
            spec.paths
                .paths
                .contains_key("/api/vault/board/cycles/{id}"),
            "expected /api/vault/board/cycles/{{id}} in paths"
        );
        // Board schemas
        let schemas = spec.components.unwrap();
        assert!(
            schemas.schemas.contains_key("BoardTask"),
            "expected BoardTask in components"
        );
        assert!(
            schemas.schemas.contains_key("BoardResponse"),
            "expected BoardResponse in components"
        );
        assert!(
            schemas.schemas.contains_key("BoardColumn"),
            "expected BoardColumn in components"
        );
        assert!(
            schemas.schemas.contains_key("BoardCycle"),
            "expected BoardCycle in components"
        );
        assert!(
            schemas.schemas.contains_key("BoardOperation"),
            "expected BoardOperation in components"
        );
        assert!(
            schemas.schemas.contains_key("CreateTaskRequest"),
            "expected CreateTaskRequest in components"
        );
        assert!(
            schemas.schemas.contains_key("PatchTaskRequest"),
            "expected PatchTaskRequest in components"
        );
        assert!(
            schemas.schemas.contains_key("CreateCycleRequest"),
            "expected CreateCycleRequest in components"
        );
        assert!(
            schemas.schemas.contains_key("PatchCycleRequest"),
            "expected PatchCycleRequest in components"
        );
    }
}
