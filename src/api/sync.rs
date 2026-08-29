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
use axum::extract::State;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::gitsync::SyncError;
use crate::vault::gitsync::conflict_copy::ConflictCopy;
use crate::vault::gitsync::engine::{MergeSummary, PushStatus, SyncReport, SyncStatus};
use crate::vault::gitsync::journal_merge::JournalMerge;

/// Message used wherever an uninitialised vault is refused, so the API and
/// the CLI say the same thing.
const NOT_INITIALISED: &str = "sync is not initialised for this vault — run `clep sync init`";

/// One "theirs" side written beside the page it conflicted with (ADR 0004).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConflictCopyDto {
    /// Vault-relative path of the page that kept its local content.
    pub original: String,
    /// Vault-relative path of the copy holding the incoming content.
    pub copy: String,
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

    pub(crate) fn from_status(
        status: &SyncStatus,
        pending_autocommit: bool,
        syncing: bool,
    ) -> Self {
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
    let status = runtime.status().await.map_err(sync_error)?;
    Ok(Json(SyncStatusDto::from_status(
        &status,
        runtime.pending_autocommit(),
        runtime.syncing(),
    )))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", post(run_sync))
        .route("/status", get(sync_status))
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
