//! Git-backed vault synchronisation endpoints (D10, D13).
//!
//! `POST /sync` runs one whole sync inside the quiesce window; the request
//! only returns once the merge, the index rebuild and the push are done, so a
//! client that gets a report can trust the vault it reads next. `GET
//! /sync/status` is read-only and cheap enough to poll.
//!
//! Both speak flat, string-tagged DTOs rather than the engine's enums: `clep
//! sync` deserializes exactly these shapes back out of the server and renders
//! them with the same code that renders a standalone run.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use super::rubbish::RubbishItemSummary;
use crate::api::error::parse_request_path;
use crate::vault::gitsync::SyncError;
use crate::vault::gitsync::conflict_copy::{ConflictCopy, comparable_pair};
use crate::vault::gitsync::engine::{MergeSummary, PushStatus, SyncReport, SyncStatus};
use crate::vault::gitsync::journal_merge::JournalMerge;
use crate::vault::mutation_coordinator::{MutationError, ProjectAssignment, UpdatePageCommand};
use crate::vault::page::{Page, PageMeta, page_revision, parse_frontmatter};
use crate::vault::path::VaultPath;

/// Message used wherever an uninitialised vault is refused, so the API and
/// the CLI say the same thing.
const NOT_INITIALISED: &str = "sync is not initialised for this vault — run `clep sync init`";

/// What counts as a Conflict Copy row in `page_properties`, shared between
/// the status count and the conflict list so the two can never disagree.
///
/// `page_properties`' primary key is `(page_id, key, ord)` — a schema-blind
/// projection stores one row per array element, so a page whose `conflict_of`
/// was ever hand-edited (or foreign-tool-written) into a TOML array would
/// otherwise be counted and listed once per element. `ord = 0` keeps exactly
/// one row per page regardless of whether the value is a scalar string (the
/// sync engine's own shape, ADR 0004, always `ord = 0`) or an array.
const CONFLICT_OF_FILTER: &str =
    "pp.key = 'conflict_of' AND pp.ord = 0 AND pp.value_text IS NOT NULL";

/// One "theirs" side written beside the page it conflicted with (ADR 0004).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictCopyDto {
    /// Vault-relative path of the page that kept its local content.
    pub original: String,
    /// Vault-relative path of the copy holding the incoming content.
    pub copy: String,
}

/// One Conflict Copy page, as indexed.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictPageDto {
    /// Vault-relative path of the copy.
    pub path: String,
    pub title: Option<String>,
    /// `conflict_of`: the page whose local version won the merge.
    pub original: String,
    pub original_title: Option<String>,
    /// False when the original has since been deleted or moved.
    pub original_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictListDto {
    pub items: Vec<ConflictPageDto>,
    pub total: usize,
}

/// One side of a Conflict Copy, ready for a line diff.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictSideDto {
    /// The page in comparable form: re-serialised frontmatter with the
    /// original's `id`, no `updated_at`, and none of the copy-only keys.
    pub text: String,
    /// Revision of the raw file bytes, for the resolve request's guard.
    pub revision: String,
}

/// A Conflict Copy and its original, side by side.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictCompareDto {
    pub copy_path: String,
    pub original_path: String,
    pub original_title: Option<String>,
    /// The original: the version that stayed at its path.
    pub local: ConflictSideDto,
    /// The copy: the incoming version sync wrote beside it.
    pub other: ConflictSideDto,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ConflictCompareQuery {
    /// Vault-relative path of the Conflict Copy.
    pub copy: String,
}

/// Write `merged` into the original and move the copy to the Rubbish Bin.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictResolveRequest {
    /// Vault-relative path of the Conflict Copy.
    pub copy: String,
    /// The whole resolved page, frontmatter included. Its `id` is replaced by
    /// the original's and `conflict_of` is dropped.
    pub merged: String,
    /// `local.revision` from the compare response.
    pub original_revision: String,
    /// `other.revision` from the compare response.
    pub copy_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictResolveDto {
    pub original_path: String,
    /// The copy's Rubbish Bin entry.
    pub archived: RubbishItemSummary,
}

/// Duplicate journal pages for one date, folded into one page (D22).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct JournalMergeDto {
    /// `journals` or `ai-journals`.
    pub folder: String,
    pub date: String,
    pub winner: String,
    pub merged: Vec<String>,
}

/// The result of one sync.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SyncReportDto {
    /// Sha of the commit this sync made, or `null` when the tree was clean.
    pub committed: Option<String>,
    pub files_committed: usize,
    /// `no_remote` | `fetch_failed` | `not_fetched` | `up_to_date` |
    /// `fast_forward` | `merged`.
    pub merge: String,
    /// The new head for `fast_forward`/`merged`, the failure for
    /// `fetch_failed`, `null` otherwise.
    pub merge_detail: Option<String>,
    pub conflict_copies: Vec<ConflictCopyDto>,
    /// Duplicate journal pages this sync folded into one.
    pub journal_merges: Vec<JournalMergeDto>,
    /// `not_attempted` | `nothing_to_push` | `pushed` | `rejected` | `failed`.
    pub push: String,
    pub push_detail: Option<String>,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

/// What `clep sync status` and the UI read.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SyncStatusDto {
    /// `false` when the vault is not a `clep sync init`-ed repository; every
    /// other field is then a placeholder.
    pub initialised: bool,
    pub branch: String,
    pub remote: Option<String>,
    pub head: Option<String>,
    /// Commits ahead of / behind `origin/<branch>`; `null` when there is no
    /// remote-tracking branch yet.
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    pub dirty_files: usize,
    pub unmerged_files: usize,
    pub conflict_copies: usize,
    pub last_sync_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_sync_result: Option<String>,
    /// A vault change is waiting out its autocommit quiet period.
    pub pending_autocommit: bool,
    /// A sync is running right now.
    pub syncing: bool,
}

impl SyncStatusDto {
    /// The answer for a vault the server has no sync runtime for. Reported as
    /// `200` rather than an error: "is this vault synced?" is a legitimate
    /// question with "no" for an answer.
    fn uninitialised() -> Self {
        Self {
            initialised: false,
            branch: String::new(),
            remote: None,
            head: None,
            ahead: None,
            behind: None,
            dirty_files: 0,
            unmerged_files: 0,
            conflict_copies: 0,
            last_sync_at: None,
            last_sync_result: None,
            pending_autocommit: false,
            syncing: false,
        }
    }

    pub fn from_status(status: &SyncStatus, pending_autocommit: bool, syncing: bool) -> Self {
        Self {
            initialised: status.initialised,
            branch: status.branch.clone(),
            remote: status.remote.clone(),
            head: status.head.clone(),
            ahead: status.ahead,
            behind: status.behind,
            dirty_files: status.dirty_files,
            unmerged_files: status.unmerged_files,
            conflict_copies: status.conflict_copies,
            last_sync_at: status.last_sync_at,
            last_sync_result: status.last_sync_result.clone(),
            pending_autocommit,
            syncing,
        }
    }
}

impl From<&ConflictCopy> for ConflictCopyDto {
    fn from(copy: &ConflictCopy) -> Self {
        Self {
            original: copy.original.clone(),
            copy: copy.copy.clone(),
        }
    }
}

impl From<&JournalMerge> for JournalMergeDto {
    fn from(merge: &JournalMerge) -> Self {
        Self {
            folder: merge.folder.clone(),
            date: merge.date.clone(),
            winner: merge.winner.clone(),
            merged: merge.merged.clone(),
        }
    }
}

impl From<&SyncReport> for SyncReportDto {
    fn from(report: &SyncReport) -> Self {
        let (merge, merge_detail) = match &report.merge {
            MergeSummary::NoRemote => ("no_remote", None),
            MergeSummary::FetchFailed(detail) => ("fetch_failed", Some(detail.clone())),
            MergeSummary::NotFetched => ("not_fetched", None),
            MergeSummary::UpToDate => ("up_to_date", None),
            MergeSummary::FastForward { head } => ("fast_forward", Some(head.clone())),
            MergeSummary::Merged { commit, .. } => ("merged", Some(commit.clone())),
        };
        let (push, push_detail) = match &report.push {
            PushStatus::NotAttempted => ("not_attempted", None),
            PushStatus::NothingToPush => ("nothing_to_push", None),
            PushStatus::Pushed => ("pushed", None),
            PushStatus::Rejected(detail) => ("rejected", Some(detail.clone())),
            PushStatus::Failed(detail) => ("failed", Some(detail.clone())),
        };
        Self {
            committed: report.committed.as_ref().map(|commit| commit.sha.clone()),
            files_committed: report.committed.as_ref().map_or(0, |commit| commit.files),
            merge: merge.to_string(),
            merge_detail,
            conflict_copies: report
                .conflict_copies()
                .iter()
                .map(ConflictCopyDto::from)
                .collect(),
            journal_merges: report
                .journal_merges
                .iter()
                .map(JournalMergeDto::from)
                .collect(),
            push: push.to_string(),
            push_detail,
            warnings: report.warnings.clone(),
            duration_ms: (report.finished_at - report.started_at)
                .num_milliseconds()
                .max(0) as u64,
        }
    }
}

/// The sync failures a client can act on get a `409` — an uninitialised
/// vault (with the `clep sync init` hint) and a repository already busy with
/// a cherry-pick, revert or rebase the user has to finish. Everything else is
/// a `500`.
fn sync_error(error: SyncError) -> ApiError {
    match error {
        SyncError::NotInitialised => ApiError::conflict(NOT_INITIALISED),
        busy @ SyncError::GitOperationInProgress { .. } => ApiError::conflict(busy.to_string()),
        other => ApiError::internal(other.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/sync",
    context_path = "/api/vault",
    tag = "Sync",
    responses(
        (status = 200, description = "Sync report", body = SyncReportDto),
        (status = 409, description = "Sync is not initialised for this vault, or a cherry-pick, revert or rebase is in progress", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn run_sync(State(state): State<Arc<AppState>>) -> Result<Json<SyncReportDto>, ApiError> {
    let runtime = state
        .sync
        .clone()
        .ok_or_else(|| ApiError::conflict(NOT_INITIALISED))?;
    let report = runtime.run_full_sync(&state).await.map_err(sync_error)?;
    Ok(Json(SyncReportDto::from(&report)))
}

#[utoipa::path(
    get,
    path = "/sync/status",
    context_path = "/api/vault",
    tag = "Sync",
    responses(
        (status = 200, description = "Sync status; `initialised` is false when the vault is not a sync repository", body = SyncStatusDto),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn sync_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SyncStatusDto>, ApiError> {
    let Some(runtime) = state.sync.clone() else {
        return Ok(Json(SyncStatusDto::uninitialised()));
    };
    let conflict_copies = state
        .index
        .with_index(|index, _vault| {
            index.connection().query_row(
                &format!("SELECT count(*) FROM page_properties pp WHERE {CONFLICT_OF_FILTER}"),
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))? as usize;
    let status = runtime
        .status_with_copies(conflict_copies)
        .await
        .map_err(sync_error)?;
    Ok(Json(SyncStatusDto::from_status(
        &status,
        runtime.pending_autocommit(),
        runtime.syncing(),
    )))
}

#[utoipa::path(
    get,
    path = "/sync/conflicts",
    context_path = "/api/vault",
    tag = "Sync",
    responses(
        (status = 200, description = "Conflict Copies present in the vault, from the index", body = ConflictListDto),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_conflicts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ConflictListDto>, ApiError> {
    let items = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .prepare(&format!(
                    "SELECT p.path, p.title, pp.value_text, o.path, o.title \
                     FROM page_properties pp \
                     JOIN pages p ON p.id = pp.page_id \
                     LEFT JOIN pages o ON o.path = pp.value_text \
                     WHERE {CONFLICT_OF_FILTER} \
                     ORDER BY p.path"
                ))?
                .query_map([], |row| {
                    let original: String = row.get(2)?;
                    let original_exists: Option<String> = row.get(3)?;
                    Ok(ConflictPageDto {
                        path: row.get(0)?,
                        title: row.get(1)?,
                        original_exists: original_exists.is_some(),
                        original,
                        original_title: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, rusqlite::Error>>()
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;

    Ok(Json(ConflictListDto {
        total: items.len(),
        items,
    }))
}

/// Conflicts only a person can resolve in an editor: an encrypted side, or
/// frontmatter that does not parse.
fn resolve_by_hand(message: impl Into<String>) -> ApiError {
    ApiError::unprocessable_with_detail(message, serde_json::json!({ "code": "resolve_by_hand" }))
}

/// A page read for comparison: its raw text and parsed frontmatter.
struct ConflictSide {
    path: VaultPath,
    raw: String,
    meta: PageMeta,
}

impl ConflictSide {
    fn revision(&self) -> String {
        page_revision(&self.raw)
    }
}

/// Read and parse the page at `path`. Missing is a 404; unparseable or
/// encrypted is a 422 (D7).
fn read_conflict_side(state: &AppState, path: VaultPath) -> Result<ConflictSide, ApiError> {
    let page =
        Page::from_file(&state.vault.resolve(&path), path.clone()).map_err(
            |error| match error {
                crate::vault::page::FrontmatterError::Io(error)
                    if error.kind() == std::io::ErrorKind::NotFound =>
                {
                    ApiError::not_found(format!("page not found: {}", path.as_str()))
                }
                crate::vault::page::FrontmatterError::Io(error) => {
                    ApiError::internal(format!("failed to read {}: {error}", path.as_str()))
                }
                error => resolve_by_hand(format!(
                    "{} has frontmatter that does not parse ({error}); resolve it by hand",
                    path.as_str()
                )),
            },
        )?;
    if page.is_encrypted() {
        return Err(resolve_by_hand(format!(
            "{} is encrypted; resolve it by hand",
            path.as_str()
        )));
    }
    Ok(ConflictSide {
        path,
        raw: page.raw_content,
        meta: page.meta,
    })
}

/// The copy at `copy` and the original its `conflict_of` names.
fn read_conflict(state: &AppState, copy: &str) -> Result<(ConflictSide, ConflictSide), ApiError> {
    let copy = read_conflict_side(state, parse_request_path(copy, "invalid copy path")?)?;
    let original = copy
        .meta
        .extra
        .get("conflict_of")
        .and_then(toml::Value::as_str)
        .ok_or_else(|| {
            ApiError::not_found(format!("{} is not a Conflict Copy", copy.path.as_str()))
        })?;
    let original = VaultPath::new(original).map_err(|_| {
        ApiError::not_found(format!(
            "{} names an invalid original: {original}",
            copy.path.as_str()
        ))
    })?;
    let original = read_conflict_side(state, original)?;
    Ok((original, copy))
}

#[utoipa::path(
    get,
    path = "/sync/conflicts/compare",
    context_path = "/api/vault",
    tag = "Sync",
    params(ConflictCompareQuery),
    responses(
        (status = 200, description = "The original and the Conflict Copy in comparable form", body = ConflictCompareDto),
        (status = 400, description = "Invalid copy path", body = ApiError),
        (status = 404, description = "The copy is missing, is not a Conflict Copy, or its original is missing", body = ApiError),
        (status = 422, description = "A side is encrypted or has unparseable frontmatter; resolve it by hand", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn compare_conflict(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ConflictCompareQuery>,
) -> Result<Json<ConflictCompareDto>, ApiError> {
    let (original, copy) = read_conflict(&state, &query.copy)?;
    let (local, other) = comparable_pair(&original.raw, &copy.raw).map_err(|error| {
        resolve_by_hand(format!(
            "frontmatter does not parse ({error}); resolve it by hand"
        ))
    })?;
    Ok(Json(ConflictCompareDto {
        copy_path: copy.path.as_str().to_string(),
        original_path: original.path.as_str().to_string(),
        original_title: original.meta.title.clone(),
        local: ConflictSideDto {
            text: local,
            revision: original.revision(),
        },
        other: ConflictSideDto {
            text: other,
            revision: copy.revision(),
        },
    }))
}

#[utoipa::path(
    post,
    path = "/sync/conflicts/resolve",
    context_path = "/api/vault",
    tag = "Sync",
    request_body = ConflictResolveRequest,
    responses(
        (status = 200, description = "Original written and the copy moved to the Rubbish Bin", body = ConflictResolveDto),
        (status = 400, description = "Invalid copy path, or merged text whose frontmatter does not parse", body = ApiError),
        (status = 404, description = "The copy is missing, is not a Conflict Copy, or its original is missing", body = ApiError),
        (status = 409, description = "The original or the copy changed since it was compared (`revision_conflict`)", body = ApiError),
        (status = 422, description = "A side is encrypted or has unparseable frontmatter; resolve it by hand", body = ApiError),
        (status = 500, description = "Internal server error; when the original was saved but the copy could not be binned, the message says so", body = ApiError)
    )
)]
pub async fn resolve_conflict(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ConflictResolveRequest>,
) -> Result<Json<ConflictResolveDto>, ApiError> {
    let (original, copy) = read_conflict(&state, &request.copy)?;
    // Both guards before any write: a stale copy must not leave a half-done
    // resolution behind.
    for (side, expected) in [
        (&original, &request.original_revision),
        (&copy, &request.copy_revision),
    ] {
        let current = side.revision();
        if &current != expected {
            return Err(ApiError::revision_conflict(current));
        }
    }
    let (mut meta, body) = parse_frontmatter(&request.merged)
        .map_err(|error| ApiError::bad_request(format!("merged page does not parse: {error}")))?;
    if meta.encryption.is_some() {
        return Err(ApiError::bad_request("merged page must not be encrypted"));
    }
    meta.id = original.meta.id;
    meta.extra.remove("conflict_of");
    meta.updated_at = Some(state.clock.now());

    let notify = |notification: crate::vault::mutation_coordinator::MutationNotification| {
        let _ = state
            .change_tx
            .send(crate::api::events::SyncNotification::IndexChanged {
                upserted: notification.upserted,
                removed: notification.removed,
            });
    };
    let original_path = original.path.as_str().to_string();
    let original_abs = state.vault.resolve(&original.path);
    match state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            UpdatePageCommand {
                path: original.path,
                expected_content: original.raw,
                meta,
                body,
                project: ProjectAssignment::Unchanged,
                reconcile: false,
            },
            &notify,
        )
        .await
    {
        Ok(_) => {}
        Err(MutationError::Stale(_)) => {
            let current = std::fs::read_to_string(&original_abs).unwrap_or_default();
            return Err(ApiError::revision_conflict(page_revision(&current)));
        }
        Err(error) => return Err(super::mutation_error(error)),
    }

    let archived =
        super::pages::archive_page_bytes(&state, &copy.path, copy.raw.into_bytes())
            .await
            .map_err(|error| {
                ApiError::internal(format!(
                    "{original_path} was saved, but the Conflict Copy {} could not be moved to the Rubbish Bin and remains: {}",
                    copy.path.as_str(),
                    error.error
                ))
            })?;
    Ok(Json(ConflictResolveDto {
        original_path,
        archived,
    }))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", post(run_sync))
        .route("/status", get(sync_status))
        .route("/conflicts", get(list_conflicts))
        .route("/conflicts/compare", get(compare_conflict))
        .route("/conflicts/resolve", post(resolve_conflict))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use axum_test::TestServer;

    use super::*;

    /// The failures the user can act on are conflicts, not server errors: an
    /// uninitialised vault, and a repository busy with an operation only they
    /// can finish.
    #[test]
    fn user_actionable_sync_errors_are_conflicts() {
        assert_eq!(sync_error(SyncError::NotInitialised).status, 409);
        assert_eq!(
            sync_error(SyncError::GitOperationInProgress {
                operation: "cherry-pick".to_string(),
            })
            .status,
            409
        );
        assert_eq!(sync_error(SyncError::MissingAuthor).status, 500);
    }

    #[tokio::test]
    async fn status_reports_uninitialised_for_plain_vault_and_sync_is_409() {
        let (state, _tmp) = crate::state_test_support::make_state().await;
        let server = TestServer::new(crate::api::api_router().with_state(state)).unwrap();

        let status: SyncStatusDto = server.get("/sync/status").await.json();
        assert!(!status.initialised);
        assert_eq!(status.dirty_files, 0);
        assert!(!status.pending_autocommit);

        let response = server.post("/sync").await;
        assert_eq!(response.status_code(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn conflicts_endpoint_lists_copies_from_the_index() {
        let (state, _tmp) = crate::state_test_support::make_state().await;
        let server =
            TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();
        // A conflict copy page + its original, indexed.
        let root = state.vault.root().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(
            root.join("notes/plan.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000c1\"\ntitle = \"Plan\"\n+++\nours\n",
        )
        .unwrap();
        std::fs::write(
            root.join("notes/plan.conflict.abc1234.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000c2\"\ntitle = \"Plan (conflict abc1234)\"\nconflict_of = \"notes/plan.md\"\n+++\ntheirs\n",
        )
        .unwrap();
        let rebuild = server.post("/index/rebuild").await;
        assert_eq!(rebuild.status_code(), StatusCode::OK);

        let list: ConflictListDto = server.get("/sync/conflicts").await.json();
        assert_eq!(list.total, 1);
        assert_eq!(list.items[0].path, "notes/plan.conflict.abc1234.md");
        assert_eq!(list.items[0].original, "notes/plan.md");
        assert!(list.items[0].original_exists);
        assert_eq!(list.items[0].original_title.as_deref(), Some("Plan"));
        // A plain vault (no sync runtime) still answers.
        let status: SyncStatusDto = server.get("/sync/status").await.json();
        assert!(!status.initialised);
    }

    /// A hand-edited (or foreign-tool-written) `conflict_of` can legitimately
    /// be a TOML array rather than the sync engine's own scalar string (ADR
    /// 0004) — `page_properties` then holds one row per element. The status
    /// count and the conflict list must still agree, and both must count the
    /// page once, not once per element.
    #[tokio::test]
    async fn conflicts_endpoint_dedupes_a_list_typed_conflict_of() {
        let (state, repos) = crate::sync_runtime::tests::synced_state().await;
        let server =
            TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();
        std::fs::create_dir_all(repos.a.join("notes")).unwrap();
        std::fs::write(
            repos.a.join("notes/plan.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000d1\"\ntitle = \"Plan\"\n+++\nours\n",
        )
        .unwrap();
        std::fs::write(
            repos.a.join("notes/plan.conflict.def5678.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000d2\"\ntitle = \"Plan (conflict def5678)\"\nconflict_of = [\"notes/plan.md\", \"notes/other.md\"]\n+++\ntheirs\n",
        )
        .unwrap();
        assert_eq!(
            server.post("/index/rebuild").await.status_code(),
            StatusCode::OK
        );

        let list: ConflictListDto = server.get("/sync/conflicts").await.json();
        assert_eq!(list.total, 1, "{list:?}");
        assert_eq!(list.items.len(), 1, "{list:?}");
        assert_eq!(list.items[0].path, "notes/plan.conflict.def5678.md");

        let status: SyncStatusDto = server.get("/sync/status").await.json();
        assert!(status.initialised);
        assert_eq!(
            status.conflict_copies, 1,
            "the status count and the list must never disagree"
        );
    }

    /// No Conflict Copies at all: an empty list, not an error, and the status
    /// count (computed by the same real query, since a sync runtime is
    /// present here) agrees.
    #[tokio::test]
    async fn conflicts_endpoint_reports_zero_when_there_are_no_copies() {
        let (state, _repos) = crate::sync_runtime::tests::synced_state().await;
        let server =
            TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();

        let list: ConflictListDto = server.get("/sync/conflicts").await.json();
        assert!(list.items.is_empty(), "{list:?}");
        assert_eq!(list.total, 0);

        let status: SyncStatusDto = server.get("/sync/status").await.json();
        assert!(status.initialised);
        assert_eq!(status.conflict_copies, 0);
    }

    /// The original a copy names has since been deleted or moved: the copy
    /// still lists, but `original_exists` is false and there is no title to
    /// report for a page that is not there.
    #[tokio::test]
    async fn conflicts_endpoint_reports_a_deleted_original_as_absent() {
        let (state, _tmp) = crate::state_test_support::make_state().await;
        let server =
            TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();
        let root = state.vault.root().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(
            root.join("notes/plan.conflict.ghi9012.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000e2\"\ntitle = \"Plan (conflict ghi9012)\"\nconflict_of = \"notes/plan.md\"\n+++\ntheirs\n",
        )
        .unwrap();
        assert_eq!(
            server.post("/index/rebuild").await.status_code(),
            StatusCode::OK
        );

        let list: ConflictListDto = server.get("/sync/conflicts").await.json();
        assert_eq!(list.total, 1, "{list:?}");
        assert!(!list.items[0].original_exists);
        assert_eq!(list.items[0].original_title, None);
    }

    const PLAN_ID: &str = "0192b6c0-0000-7000-8000-0000000000f1";
    const PLAN: &str = "+++\nid = \"0192b6c0-0000-7000-8000-0000000000f1\"\ntitle = \"Plan\"\ncreated_at = 2026-08-01T10:00:00Z\nupdated_at = 2026-09-01T10:00:00Z\n+++\nshared\nours\n";
    const PLAN_COPY: &str = "notes/plan.conflict.abc1234.md";

    /// A server over a vault holding `notes/plan.md` (`original`) and its
    /// Conflict Copy of `theirs`, written the way the sync engine writes it.
    async fn conflict_fixture(
        original: &str,
        theirs: &str,
    ) -> (TestServer, Arc<AppState>, tempfile::TempDir) {
        let (state, tmp) = crate::state_test_support::make_state().await;
        let server =
            TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();
        let root = state.vault.root().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/plan.md"), original).unwrap();
        let copy = crate::vault::gitsync::conflict_copy::conflict_copy_content(
            "notes/plan.md",
            theirs.as_bytes(),
            "abc1234",
        );
        std::fs::write(root.join(PLAN_COPY), copy).unwrap();
        assert_eq!(
            server.post("/index/rebuild").await.status_code(),
            StatusCode::OK
        );
        (server, state, tmp)
    }

    fn read(state: &AppState, rel: &str) -> String {
        std::fs::read_to_string(state.vault.root().join(rel)).unwrap()
    }

    fn revision(text: &str) -> String {
        crate::vault::page::page_revision(text)
    }

    #[tokio::test]
    async fn compare_returns_both_sides_in_comparable_form() {
        let theirs = PLAN
            .replace("ours", "theirs")
            .replace("2026-09-01", "2026-09-05");
        let (server, state, _tmp) = conflict_fixture(PLAN, &theirs).await;

        let response = server
            .get("/sync/conflicts/compare")
            .add_query_param("copy", PLAN_COPY)
            .await;
        assert_eq!(
            response.status_code(),
            StatusCode::OK,
            "{}",
            response.text()
        );
        let compare: ConflictCompareDto = response.json();
        assert_eq!(compare.copy_path, PLAN_COPY);
        assert_eq!(compare.original_path, "notes/plan.md");
        assert_eq!(compare.original_title.as_deref(), Some("Plan"));
        assert_eq!(
            compare.local.revision,
            revision(&read(&state, "notes/plan.md"))
        );
        assert_eq!(compare.other.revision, revision(&read(&state, PLAN_COPY)));
        // Only the body differs: same id, no copy-only keys, no timestamps.
        assert_eq!(
            compare.local.text.replace("ours", "theirs"),
            compare.other.text,
            "{compare:?}"
        );
        assert!(compare.other.text.contains(PLAN_ID), "{compare:?}");
        assert!(!compare.other.text.contains("conflict"), "{compare:?}");
    }

    #[tokio::test]
    async fn compare_is_404_for_a_page_that_is_not_a_copy_or_is_missing() {
        let (server, _state, _tmp) = conflict_fixture(PLAN, PLAN).await;
        for copy in ["notes/plan.md", "notes/nothing.conflict.abc1234.md"] {
            let response = server
                .get("/sync/conflicts/compare")
                .add_query_param("copy", copy)
                .await;
            assert_eq!(response.status_code(), StatusCode::NOT_FOUND, "{copy}");
        }
    }

    #[tokio::test]
    async fn compare_is_404_when_the_original_is_gone() {
        let (server, state, _tmp) = conflict_fixture(PLAN, PLAN).await;
        std::fs::remove_file(state.vault.root().join("notes/plan.md")).unwrap();
        let response = server
            .get("/sync/conflicts/compare")
            .add_query_param("copy", PLAN_COPY)
            .await;
        assert_eq!(response.status_code(), StatusCode::NOT_FOUND);
    }

    fn protected_plan() -> String {
        format!(
            "+++\nid = \"{PLAN_ID}\"\ntitle = \"Plan\"\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\n+++\n{}",
            clep_test_support::PRIVATE_NOTE_AGE
        )
    }

    #[tokio::test]
    async fn compare_and_resolve_are_422_for_an_encrypted_side() {
        let (server, state, _tmp) = conflict_fixture(&protected_plan(), PLAN).await;
        let response = server
            .get("/sync/conflicts/compare")
            .add_query_param("copy", PLAN_COPY)
            .await;
        assert_eq!(
            response.status_code(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            response.text()
        );

        let response = server
            .post("/sync/conflicts/resolve")
            .json(&ConflictResolveRequest {
                copy: PLAN_COPY.to_string(),
                merged: PLAN.to_string(),
                original_revision: revision(&read(&state, "notes/plan.md")),
                copy_revision: revision(&read(&state, PLAN_COPY)),
            })
            .await;
        assert_eq!(response.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    async fn compare(server: &TestServer) -> ConflictCompareDto {
        server
            .get("/sync/conflicts/compare")
            .add_query_param("copy", PLAN_COPY)
            .await
            .json()
    }

    #[tokio::test]
    async fn resolve_writes_the_original_and_bins_the_copy() {
        let theirs = PLAN.replace("ours", "theirs");
        let (server, state, _tmp) = conflict_fixture(PLAN, &theirs).await;
        let sides = compare(&server).await;
        let merged = sides.other.text.replace("theirs", "ours\ntheirs");

        let response = server
            .post("/sync/conflicts/resolve")
            .json(&ConflictResolveRequest {
                copy: PLAN_COPY.to_string(),
                merged,
                original_revision: sides.local.revision,
                copy_revision: sides.other.revision,
            })
            .await;
        assert_eq!(
            response.status_code(),
            StatusCode::OK,
            "{}",
            response.text()
        );
        let resolved: ConflictResolveDto = response.json();
        assert_eq!(resolved.original_path, "notes/plan.md");
        assert_eq!(resolved.archived.original_path, PLAN_COPY);

        let written = read(&state, "notes/plan.md");
        let (meta, body) = crate::vault::page::parse_frontmatter(&written).unwrap();
        assert_eq!(meta.id.to_string(), PLAN_ID);
        assert_eq!(meta.title.as_deref(), Some("Plan"));
        assert!(!meta.extra.contains_key("conflict_of"), "{written}");
        assert!(meta.updated_at.is_some());
        assert_eq!(body, "shared\nours\ntheirs\n");
        assert!(!state.vault.root().join(PLAN_COPY).exists());

        let rubbish = server.get("/rubbish").await.text();
        assert!(rubbish.contains(PLAN_COPY), "{rubbish}");
        let list: ConflictListDto = server.get("/sync/conflicts").await.json();
        assert_eq!(list.total, 0, "{list:?}");
    }

    #[tokio::test]
    async fn resolve_with_a_stale_revision_is_409_and_changes_nothing() {
        let theirs = PLAN.replace("ours", "theirs");
        let (server, state, _tmp) = conflict_fixture(PLAN, &theirs).await;
        let sides = compare(&server).await;
        let original_before = read(&state, "notes/plan.md");
        let copy_before = read(&state, PLAN_COPY);

        for (original_revision, copy_revision) in [
            ("stale".to_string(), sides.other.revision.clone()),
            (sides.local.revision.clone(), "stale".to_string()),
        ] {
            let response = server
                .post("/sync/conflicts/resolve")
                .json(&ConflictResolveRequest {
                    copy: PLAN_COPY.to_string(),
                    merged: sides.other.text.clone(),
                    original_revision,
                    copy_revision,
                })
                .await;
            assert_eq!(response.status_code(), StatusCode::CONFLICT);
            let error: serde_json::Value = response.json();
            assert_eq!(error["detail"]["code"], "revision_conflict", "{error}");
            assert_eq!(read(&state, "notes/plan.md"), original_before);
            assert_eq!(read(&state, PLAN_COPY), copy_before);
        }
    }

    #[tokio::test]
    async fn resolve_rejects_unparseable_merged_text() {
        let (server, state, _tmp) = conflict_fixture(PLAN, PLAN).await;
        let sides = compare(&server).await;
        let original_before = read(&state, "notes/plan.md");
        let response = server
            .post("/sync/conflicts/resolve")
            .json(&ConflictResolveRequest {
                copy: PLAN_COPY.to_string(),
                merged: "no frontmatter at all\n".to_string(),
                original_revision: sides.local.revision,
                copy_revision: sides.other.revision,
            })
            .await;
        assert_eq!(response.status_code(), StatusCode::BAD_REQUEST);
        assert_eq!(read(&state, "notes/plan.md"), original_before);
        assert!(state.vault.root().join(PLAN_COPY).exists());
    }

    #[tokio::test]
    async fn sync_endpoint_runs_a_full_sync() {
        let (state, repos) = crate::sync_runtime::tests::synced_state().await;
        let server =
            TestServer::new(crate::api::api_router().with_state(Arc::clone(&state))).unwrap();
        std::fs::write(
            repos.a.join("api.md"),
            "+++\nid = \"0192b6c0-0000-7000-8000-0000000000e1\"\ntitle = \"Api\"\n+++\n",
        )
        .unwrap();

        let report: SyncReportDto = server.post("/sync").await.json();
        assert!(report.committed.is_some());
        assert!(report.files_committed >= 1, "{report:?}");
        assert_eq!(report.push, "pushed");

        let status: SyncStatusDto = server.get("/sync/status").await.json();
        assert!(status.initialised);
        assert_eq!(status.ahead, Some(0));
        assert!(status.last_sync_at.is_some());
    }
}
