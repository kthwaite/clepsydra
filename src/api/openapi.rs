use axum::Router;
use utoipa::openapi::Ref;
use utoipa::openapi::schema::{
    AdditionalProperties, Array, Object, ObjectBuilder, OneOfBuilder, Schema, SchemaType, Type,
};
use utoipa::{Modify, OpenApi};
use utoipa_swagger_ui::SwaggerUi;

struct FilterSchema;

impl Modify for FilterSchema {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let Some(components) = openapi.components.as_mut() else {
            return;
        };

        let recursive = Ref::from_schema_name("Filter");
        let closed_object = || {
            ObjectBuilder::new().additional_properties(Some(AdditionalProperties::FreeForm(false)))
        };
        let all = closed_object()
            .property("all", Array::new(recursive.clone()))
            .required("all");
        let any = closed_object()
            .property("any", Array::new(recursive.clone()))
            .required("any");
        let not = closed_object().property("not", recursive).required("not");
        let comparison = closed_object()
            .property("field", Object::with_type(Type::String))
            .property("op", Ref::from_schema_name("Op"))
            .property(
                "value",
                ObjectBuilder::new().schema_type(SchemaType::AnyValue),
            )
            .required("field")
            .required("op");
        let filter = OneOfBuilder::new()
            .item(all)
            .item(any)
            .item(not)
            .item(comparison)
            .description(Some(
                "Recursive filter AST: all, any, not, or a field comparison",
            ))
            .build();
        components
            .schemas
            .insert("Filter".to_owned(), Schema::OneOf(filter).into());
    }
}
/// OpenAPI document for the clepsydra vault API used by the UI.
#[derive(OpenApi)]
#[openapi(
    modifiers(&FilterSchema),
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
        (name = "Archive", description = "Web archives and content-addressed blobs"),
        (name = "Journal", description = "Daily journal retrieval and capture"),
        (name = "Conversations", description = "Atomic AI conversation capture"),
        (name = "Agenda", description = "Today, week and overdue task views"),
        (name = "Blocks", description = "Block lookup, search and identifiers"),
        (name = "Events", description = "Server-sent events stream"),
        (name = "BCL", description = "Brimley-Cocoon Line countdown"),
        (name = "Location", description = "Vault geographic location"),
        (name = "Uptime", description = "Server uptime"),
        (name = "Board", description = "TASKING board: read model and task/cycle mutations"),
        (name = "Feeds", description = "RSS/Atom subscriptions, entries, and refresh"),
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
        // Archive / CAS
        crate::api::archive::ingest_archive,
        crate::api::archive::archive_status,
        crate::api::archive::serve_blob,
        // Conversations
        crate::api::conversations::capture_conversation,
        crate::api::journal::get_today,
        crate::api::journal::ensure_today,
        crate::api::journal::capture_today,
        crate::api::journal::get_range,
        crate::api::journal::get_recent,
        crate::api::journal::get_by_date,
        // Tasks and agenda
        crate::api::tasks::list_tasks,
        crate::api::tasks::get_task_completion_history,
        crate::api::tasks::update_task_status,
        crate::api::agenda::agenda_today,
        crate::api::agenda::agenda_week,
        crate::api::agenda::agenda_overdue,
        crate::api::agenda::get_cycle_burndown,
        // Blocks
        crate::api::blocks::search_blocks,
        crate::api::blocks::assign_block_id,
        crate::api::blocks::get_block,
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
        crate::api::bases::preview_base,
        crate::api::bases::get_base,
        crate::api::bases::evaluate_view,
        crate::api::bases::evaluate_embedded_view,
        crate::api::bases::create_base,
        crate::api::bases::update_base,
        crate::api::bases::delete_base,
        crate::api::base_members::create_base_member,
        crate::api::query::run_query,
        crate::api::properties::patch_properties,
        // Feeds
        crate::api::feeds::list_feeds,
        crate::api::feeds::subscribe_feed,
        crate::api::feeds::update_feed,
        crate::api::feeds::delete_feed,
        crate::api::feeds::refresh_feeds,
        crate::api::feeds::refresh_feed,
        crate::api::feeds::list_entries,
        crate::api::feeds::patch_entry,
        crate::api::feeds::mark_entries_read,
        crate::api::feeds::import_opml,
        crate::api::feeds::export_opml
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
            crate::vault::base_document::ViewOrigin,
            crate::vault::base_member::BaseMemberScope,
            crate::vault::base_member::BaseMemberFieldRequirement,
            crate::vault::base_member::BaseMemberDiagnostic,
            crate::vault::base_member::BaseMemberCapability,
            crate::vault::query::QueryRow,
            crate::vault::query::GroupResult,
            crate::vault::query::QueryOutput,
            crate::api::bases::BaseSummary,
            crate::api::bases::BaseListResponse,
            crate::api::bases::BaseDetailResponse,
            crate::api::bases::CreateBaseRequest,
            crate::api::bases::UpdateBaseRequest,
            crate::api::bases::DeleteBaseRequest,
            crate::api::bases::BaseMutationResponse,
            crate::api::bases::BasePreviewRequest,
            crate::api::bases::BasePreviewResponse,
            crate::api::bases::BaseViewEvaluateRequest,
            crate::api::bases::BaseViewEvaluateResponse,
            crate::api::base_members::BaseMemberCreateRequest,
            crate::api::base_members::BaseMemberCreateResponse,
            crate::api::base_members::BaseMemberValidationDetail,
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
            // Archive / CAS
            crate::api::archive::ArchiveRequest,
            crate::api::archive::BlobUpload,
            crate::api::archive::ArchiveResponse,
            crate::api::archive::ArchiveStatus,
            crate::api::archive::ArchiveStatsResponse,
            // Conversations
            crate::api::conversations::ConversationRoleRequest,
            crate::api::conversations::CaptureConversationTurnRequest,
            crate::api::conversations::CaptureConversationRequest,
            crate::api::conversations::CaptureConversationOperation,
            crate::api::conversations::CaptureConversationResponse,
            crate::api::conversations::ConversationSummaryResponse,
            crate::api::journal::CaptureRequest,
            crate::api::journal::JournalSummary,
            crate::api::journal::JournalTodayResponse,
            // Tasks and agenda
            crate::api::tasks::TaskItem,
            crate::api::tasks::TaskListResponse,
            crate::api::tasks::UpdateStatusRequest,
            crate::api::agenda::AgendaTodayResponse,
            crate::api::agenda::AgendaWeekResponse,
            crate::api::agenda::AgendaDay,
            crate::api::agenda::AgendaOverdueResponse,
            // Blocks
            crate::api::blocks::BlockResponse,
            crate::api::blocks::AssignIdRequest,
            crate::api::blocks::AssignIdResponse,
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
            crate::api::deeplink::ResolveResponse,
            // Feeds
            crate::api::feeds::FeedDto,
            crate::api::feeds::FeedGroupDto,
            crate::api::feeds::FeedDiagnosticDto,
            crate::api::feeds::FeedEntryCountsDto,
            crate::api::feeds::FeedListResponse,
            crate::api::feeds::SubscribeFeedRequest,
            crate::api::feeds::UpdateFeedRequest,
            crate::api::feeds::DeleteFeedRequest,
            crate::api::feeds::FeedMutationResponse,
            crate::api::feeds::ManifestMutationResponse,
            crate::api::feeds::RefreshFeedsResponse,
            crate::api::feeds::EntryViewDto,
            crate::api::feeds::FeedEntryDto,
            crate::api::feeds::FeedEntryPageResponse,
            crate::api::feeds::PatchFeedEntryRequest,
            crate::api::feeds::MarkFeedEntriesReadRequest,
            crate::api::feeds::MarkFeedEntriesReadResponse,
            crate::api::feeds::ImportOpmlRequest,
            crate::api::feeds::ImportOpmlResponse
        )
    )
)]
pub struct ApiDoc;

/// Routes that expose OpenAPI JSON and Swagger UI.
pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().merge(SwaggerUi::new("/api/docs").url("/api/openapi.json", ApiDoc::openapi()))
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
                "NOTE",
                "PROJECT",
                "JOURNAL",
                "TODO",
                "QUOTE",
                "BOOK",
                "CAPTURE",
                "CODE",
                "PERSON",
                "TASK",
                "CYCLE",
                "AI_CONVERSATION",
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
    fn bulk_assignment_documents_atomic_success_or_typed_error() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();
        let response = &json["components"]["schemas"]["BulkAssignResponse"];
        assert!(response["properties"].get("moved").is_some());
        assert!(response["properties"].get("unchanged").is_some());
        assert!(
            response["properties"].get("failed").is_none(),
            "atomic bulk assignment must not expose per-page failures"
        );

        let responses =
            &json["paths"]["/api/vault/pages-assign-bulk"]["post"]["responses"];
        for status in ["200", "400", "404", "409", "500"] {
            assert!(
                responses.get(status).is_some(),
                "bulk assignment should document response {status}"
            );
        }
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
        assert!(
            spec.paths
                .paths
                .contains_key("/api/vault/conversations/capture")
        );
        assert!(
            spec.components
                .as_ref()
                .unwrap()
                .schemas
                .contains_key("CaptureConversationResponse")
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
    #[test]
    fn openapi_documents_base_authoring_contract() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();

        let collection = &json["paths"]["/api/vault/bases"];
        assert!(collection.get("post").is_some());
        let item = &json["paths"]["/api/vault/bases/{slug}"];
        assert!(item.get("put").is_some());
        assert!(item.get("delete").is_some());

        for schema_name in ["UpdateBaseRequest", "DeleteBaseRequest"] {
            let schema = &json["components"]["schemas"][schema_name];
            let required = schema["required"]
                .as_array()
                .unwrap_or_else(|| panic!("{schema_name}.required should be an array"));
            assert!(
                required.iter().any(|field| field == "expected_revision"),
                "{schema_name} should require expected_revision"
            );
            assert_eq!(
                schema["properties"]["expected_revision"]["type"], "string",
                "{schema_name}.expected_revision should be a string"
            );
        }
        let update_schema = &json["components"]["schemas"]["UpdateBaseRequest"];
        let update_required = update_schema["required"]
            .as_array()
            .expect("UpdateBaseRequest.required should be an array");
        assert!(
            update_required.iter().any(|field| field == "view_origins"),
            "UpdateBaseRequest should require view_origins"
        );
        assert_eq!(
            update_schema["properties"]["view_origins"]["type"], "array",
            "UpdateBaseRequest.view_origins should be an array"
        );
        assert!(
            json["components"]["schemas"].get("ViewOrigin").is_some(),
            "ViewOrigin should be a named schema"
        );

        let detail_schema = &json["components"]["schemas"]["BaseDetailResponse"];
        let detail_fields = detail_schema["allOf"]
            .as_array()
            .expect("flattened BaseDetailResponse should use allOf")
            .iter()
            .find(|part| part["properties"].get("revision").is_some())
            .expect("BaseDetailResponse should expose revision");
        let detail_required = detail_fields["required"]
            .as_array()
            .expect("BaseDetailResponse fields should declare required properties");
        assert!(
            detail_required.iter().any(|field| field == "revision"),
            "BaseDetailResponse should require revision"
        );
        assert_eq!(
            detail_fields["properties"]["revision"]["type"], "string",
            "BaseDetailResponse.revision should be a string"
        );

        let variants = json["components"]["schemas"]["Filter"]["oneOf"]
            .as_array()
            .expect("Filter should be a recursive oneOf");
        assert_eq!(variants.len(), 4);
        assert_eq!(
            variants[0]["properties"]["all"]["items"]["$ref"],
            "#/components/schemas/Filter"
        );
        assert_eq!(
            variants[1]["properties"]["any"]["items"]["$ref"],
            "#/components/schemas/Filter"
        );
        assert_eq!(
            variants[2]["properties"]["not"]["$ref"],
            "#/components/schemas/Filter"
        );
        assert_eq!(
            variants[3]["properties"]["op"]["$ref"],
            "#/components/schemas/Op"
        );
        assert!(
            variants[3]["properties"].get("field").is_some(),
            "comparison filters should expose field"
        );
        assert!(
            variants[3]["properties"].get("value").is_some(),
            "comparison filters should expose authorable values"
        );
    }

    #[test]
    fn openapi_documents_every_feed_path_and_revision_contract() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();
        let paths = json["paths"].as_object().unwrap();

        for (path, methods) in [
            ("/api/vault/feeds", &["get", "post"][..]),
            ("/api/vault/feeds/{id}", &["patch", "delete"][..]),
            ("/api/vault/feeds/refresh", &["post"][..]),
            ("/api/vault/feeds/refresh/{id}", &["post"][..]),
            ("/api/vault/feeds/entries", &["get"][..]),
            ("/api/vault/feeds/entries/{id}", &["patch"][..]),
            ("/api/vault/feeds/entries/mark-read", &["post"][..]),
            ("/api/vault/feeds/import", &["post"][..]),
            ("/api/vault/feeds/export", &["get"][..]),
        ] {
            let item = paths
                .get(path)
                .unwrap_or_else(|| panic!("missing documented feed path {path}"));
            for method in methods {
                assert!(
                    item.get(*method).is_some(),
                    "missing {method} operation for {path}"
                );
            }
        }

        for (path, method) in [
            ("/api/vault/feeds", "post"),
            ("/api/vault/feeds/{id}", "patch"),
            ("/api/vault/feeds/{id}", "delete"),
            ("/api/vault/feeds/import", "post"),
        ] {
            let operation = &json["paths"][path][method];
            let reference =
                operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
                    .as_str()
                    .unwrap_or_else(|| {
                        panic!("{method} {path} should use a named JSON request schema")
                    });
            let schema_name = reference
                .strip_prefix("#/components/schemas/")
                .unwrap_or_else(|| panic!("unexpected request schema reference {reference}"));
            let schema = &json["components"]["schemas"][schema_name];
            let required = schema["required"]
                .as_array()
                .unwrap_or_else(|| panic!("{schema_name}.required should be an array"));
            assert!(
                required.iter().any(|field| field == "expected_revision"),
                "{method} {path} must require expected_revision"
            );
            assert_eq!(
                schema["properties"]["expected_revision"]["type"], "string",
                "{schema_name}.expected_revision should be a string"
            );
            assert!(
                operation["responses"].get("409").is_some(),
                "{method} {path} must document stale-revision conflicts"
            );
        }

        let list_reference = json["paths"]["/api/vault/feeds"]["get"]["responses"]["200"]
            ["content"]["application/json"]["schema"]["$ref"]
            .as_str()
            .expect("GET feeds should use a named response schema");
        let list_schema_name = list_reference
            .strip_prefix("#/components/schemas/")
            .expect("unexpected GET feeds schema reference");
        let list_schema = &json["components"]["schemas"][list_schema_name];
        let required = list_schema["required"]
            .as_array()
            .expect("GET feeds response should declare required fields");
        for field in ["groups", "diagnostics", "manifest_revision", "counts"] {
            assert!(
                required.iter().any(|required| required == field),
                "GET feeds response should require {field}"
            );
            assert!(
                list_schema["properties"].get(field).is_some(),
                "GET feeds response should expose {field}"
            );
        }
        assert_eq!(
            list_schema["properties"]["manifest_revision"]["type"],
            "string"
        );

        let counts_reference = list_schema["properties"]["counts"]["$ref"]
            .as_str()
            .expect("GET feeds counts should use a named response schema");
        let counts_schema_name = counts_reference
            .strip_prefix("#/components/schemas/")
            .expect("unexpected feed counts schema reference");
        let counts_schema = &json["components"]["schemas"][counts_schema_name];
        let counts_required = counts_schema["required"]
            .as_array()
            .expect("feed counts should declare required fields");
        for field in ["unread", "all", "saved"] {
            assert!(
                counts_required.iter().any(|required| required == field),
                "feed counts should require {field}"
            );
            assert_eq!(
                counts_schema["properties"][field]["type"], "integer",
                "feed count {field} should be an integer"
            );
            assert_eq!(
                counts_schema["properties"][field]["format"], "int64",
                "feed count {field} should retain the backend u64 width"
            );
        }
    }
}
