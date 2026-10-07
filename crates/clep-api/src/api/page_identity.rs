//! Page identity: from a page id to the page it names, while that page may
//! move.
//!
//! A page id is stable, but the page's path is not: a move can land between
//! the index lookup and the file access. [`read_stable_by_id`] and
//! [`mutate_stable_by_id`] own the retry for that race. Each looks up the id's path, runs the caller's attempt
//! on it, and when the attempt finds the page gone it looks the id up again:
//! a new path means the page moved, so the attempt runs again there.
//! [`page_path_by_id`] is the plain lookup, for handlers that need no retry.
//! [`read_page_once`] reads a page whose bytes guard a later write.

use std::future::Future;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::vault::kind::Kind;
use crate::vault::page::{PageMeta, parse_frontmatter};
use crate::vault::path::VaultPath;

/// How many paths [`resolve_stable_by_id`] tries before it gives up.
const BY_ID_PATH_ATTEMPTS: usize = 8;

/// Whether the attempt runs with the page's path locked. Private, so each
/// caller picks a mode by picking [`read_stable_by_id`] or
/// [`mutate_stable_by_id`]: an attempt that mutates while holding the lock
/// would deadlock on the coordinator taking the same lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathLock {
    /// Lock the path, confirm the id still maps to it, then run the attempt
    /// under the lock. For reads that must see one consistent file.
    Hold,
    /// Run the attempt unlocked. For attempts that mutate through the
    /// coordinator, which takes the path lock itself.
    Release,
}

/// Why an attempt failed.
#[derive(Debug)]
pub(crate) enum AttemptError {
    /// The page is not at the path: its file is gone, or another page is
    /// there. The page may have moved, so the attempt is retried if the id
    /// now maps to another path; otherwise this error is returned.
    Vanished(ApiError),
    /// Any other failure, returned as is.
    Failed(ApiError),
}

impl AttemptError {
    /// A 404 may mean the page moved; every other error is final.
    pub(crate) fn vanished_if_not_found(error: ApiError) -> Self {
        if error.status == axum::http::StatusCode::NOT_FOUND.as_u16() {
            Self::Vanished(error)
        } else {
            Self::Failed(error)
        }
    }
}

impl From<ApiError> for AttemptError {
    fn from(error: ApiError) -> Self {
        Self::Failed(error)
    }
}

/// Outside a retry, a vanished page is just its error.
impl From<AttemptError> for ApiError {
    fn from(error: AttemptError) -> Self {
        match error {
            AttemptError::Vanished(error) | AttemptError::Failed(error) => error,
        }
    }
}

/// What a missing file means to [`read_page_once`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MissingFile {
    /// The index holds the page, so it changed under the mutation: 409.
    Conflict,
    /// The page does not exist: 404.
    NotFound,
}

/// Read the page at `path` once: its raw content (the stale-write guard),
/// meta and body. A missing file is [`AttemptError::Vanished`] with the
/// `missing` policy's error; every other failure is a 500.
pub(crate) fn read_page_once(
    state: &AppState,
    path: &VaultPath,
    missing: MissingFile,
) -> Result<(String, PageMeta, String), AttemptError> {
    let expected = std::fs::read(state.vault.resolve(path)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AttemptError::Vanished(match missing {
                MissingFile::Conflict => {
                    ApiError::conflict(format!("page changed during mutation: {}", path.as_str()))
                }
                MissingFile::NotFound => {
                    ApiError::not_found(format!("page not found: {}", path.as_str()))
                }
            })
        } else {
            AttemptError::Failed(ApiError::internal(format!(
                "failed to read page {}: {error}",
                path.as_str()
            )))
        }
    })?;
    let expected = String::from_utf8(expected).map_err(|error| {
        ApiError::internal(format!(
            "failed to read page {} as UTF-8: {error}",
            path.as_str()
        ))
    })?;
    let (meta, body) = parse_frontmatter(&expected).map_err(|error| {
        ApiError::internal(format!("failed to parse page {}: {error}", path.as_str()))
    })?;
    Ok((expected, meta, body))
}

/// The indexed path of the page with this `id`, or `None`. With `kind`, a
/// page of any other kind counts as absent.
pub(crate) async fn page_path_by_id(
    state: &AppState,
    id: &str,
    kind: Option<Kind>,
) -> Result<Option<VaultPath>, ApiError> {
    let lookup_id = id.to_string();
    let path = state
        .index
        .with_index(move |index, _vault| index.page_path_by_id(&lookup_id, kind))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;
    path.map(|path| crate::api::error::parse_internal_path(&path, "invalid stored path"))
        .transpose()
}

/// Read the page with this `id`: run `attempt` on its path with the path
/// locked, so the attempt sees one consistent file. The attempt must not
/// mutate through the coordinator: that takes the same lock and would
/// deadlock. See [`resolve_stable_by_id`] for the retry.
pub(crate) async fn read_stable_by_id<T, F, Fut>(
    state: &AppState,
    id: &str,
    kind: Option<Kind>,
    not_found: impl Fn() -> ApiError,
    attempt: F,
) -> Result<T, ApiError>
where
    F: FnMut(VaultPath) -> Fut,
    Fut: Future<Output = Result<T, AttemptError>>,
{
    resolve_stable_by_id(state, id, kind, PathLock::Hold, not_found, attempt).await
}

/// Mutate the page with this `id`: run `attempt` on its path without the
/// path lock, because the coordinator the attempt mutates through takes that
/// lock itself; holding it here would deadlock. See
/// [`resolve_stable_by_id`] for the retry.
pub(crate) async fn mutate_stable_by_id<T, F, Fut>(
    state: &AppState,
    id: &str,
    kind: Option<Kind>,
    not_found: impl Fn() -> ApiError,
    attempt: F,
) -> Result<T, ApiError>
where
    F: FnMut(VaultPath) -> Fut,
    Fut: Future<Output = Result<T, AttemptError>>,
{
    resolve_stable_by_id(state, id, kind, PathLock::Release, not_found, attempt).await
}

/// Run `attempt` on the path of the page with this `id`, retrying when the
/// page moves. `not_found` is the error for an id the index does not hold
/// (or holds with another kind). After [`BY_ID_PATH_ATTEMPTS`] moves the
/// path counts as unstable and the call fails.
async fn resolve_stable_by_id<T, F, Fut>(
    state: &AppState,
    id: &str,
    kind: Option<Kind>,
    lock: PathLock,
    not_found: impl Fn() -> ApiError,
    mut attempt: F,
) -> Result<T, ApiError>
where
    F: FnMut(VaultPath) -> Fut,
    Fut: Future<Output = Result<T, AttemptError>>,
{
    let current = async || {
        page_path_by_id(state, id, kind)
            .await?
            .ok_or_else(&not_found)
    };
    for _ in 0..BY_ID_PATH_ATTEMPTS {
        let candidate = current().await?;
        state
            .mutation_coordinator
            .observe_page_id_lookup(&candidate);
        let guard = match lock {
            PathLock::Hold => {
                let guard = state
                    .mutation_coordinator
                    .lock_paths(std::slice::from_ref(&candidate))
                    .await;
                if current().await? != candidate {
                    continue;
                }
                Some(guard)
            }
            PathLock::Release => None,
        };
        match attempt(candidate.clone()).await {
            Ok(value) => return Ok(value),
            Err(AttemptError::Failed(error)) => return Err(error),
            Err(AttemptError::Vanished(error)) => {
                drop(guard);
                if current().await? != candidate {
                    continue;
                }
                return Err(error);
            }
        }
    }

    Err(ApiError::internal(format!(
        "page path did not stabilize for id: {id}"
    )))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use parking_lot::Mutex;

    use super::*;

    const ID: &str = "00000000-0000-0000-0000-00000000a001";

    struct Fixture {
        _tmp: tempfile::TempDir,
        state: Arc<AppState>,
    }

    async fn fixture() -> Fixture {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let state = crate::build_app_state(&root).await.unwrap();
        let fixture = Fixture { _tmp: tmp, state };
        fixture.write("notes/a.md").await;
        fixture
    }

    impl Fixture {
        /// Write the page with [`ID`] at `path` and index it there.
        async fn write(&self, path: &str) {
            let absolute = self.state.vault.root().join(path);
            fs::create_dir_all(absolute.parent().unwrap()).unwrap();
            fs::write(
                &absolute,
                format!("---\nid: {ID}\ntitle: A\ntype: task\n---\nbody\n"),
            )
            .unwrap();
            let path = VaultPath::new(path).unwrap();
            self.state
                .index
                .with_index(move |index, vault| index.index_page(vault, &path).unwrap())
                .await
                .unwrap();
        }

        /// Move the page's file from `from` to `to` and re-index both.
        async fn relocate(&self, from: &str, to: &str) {
            fs::remove_file(self.state.vault.root().join(from)).unwrap();
            let from = VaultPath::new(from).unwrap();
            self.state
                .index
                .with_index(move |index, _vault| index.remove_page(&from).unwrap())
                .await
                .unwrap();
            self.write(to).await;
        }
    }

    fn not_found() -> ApiError {
        ApiError::not_found(format!("page not found with id: {ID}"))
    }

    #[tokio::test]
    async fn page_path_by_id_is_the_plain_lookup() {
        let fixture = fixture().await;
        let state = &fixture.state;
        assert_eq!(
            page_path_by_id(state, ID, None).await.unwrap(),
            Some(VaultPath::new("notes/a.md").unwrap())
        );
        assert_eq!(
            page_path_by_id(state, ID, Some(Kind::Task)).await.unwrap(),
            Some(VaultPath::new("notes/a.md").unwrap())
        );
        assert_eq!(
            page_path_by_id(state, ID, Some(Kind::Cycle)).await.unwrap(),
            None
        );
        assert_eq!(page_path_by_id(state, "unknown", None).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_stable_path_runs_the_attempt_once_in_either_lock_mode() {
        let fixture = fixture().await;
        for lock in [PathLock::Hold, PathLock::Release] {
            let seen = Mutex::new(Vec::new());
            let value = resolve_stable_by_id(&fixture.state, ID, None, lock, not_found, |path| {
                seen.lock().push(path.as_str().to_string());
                async { Ok::<_, AttemptError>(7) }
            })
            .await
            .unwrap();
            assert_eq!(value, 7);
            assert_eq!(*seen.lock(), ["notes/a.md"]);
        }
    }

    #[tokio::test]
    async fn a_page_moved_during_the_attempt_is_retried_at_its_new_path() {
        let fixture = fixture().await;
        for lock in [PathLock::Hold, PathLock::Release] {
            let seen = Mutex::new(Vec::new());
            let value = resolve_stable_by_id(&fixture.state, ID, None, lock, not_found, |path| {
                seen.lock().push(path.as_str().to_string());
                let fixture = &fixture;
                async move {
                    if path.as_str() == "notes/a.md" {
                        fixture.relocate("notes/a.md", "moved/a.md").await;
                        return Err(AttemptError::Vanished(ApiError::not_found("gone")));
                    }
                    Ok(path.as_str().to_string())
                }
            })
            .await
            .unwrap();
            assert_eq!(value, "moved/a.md");
            assert_eq!(*seen.lock(), ["notes/a.md", "moved/a.md"]);
            fixture.relocate("moved/a.md", "notes/a.md").await;
        }
    }

    #[tokio::test]
    async fn a_vanished_page_that_did_not_move_returns_the_attempts_error() {
        let fixture = fixture().await;
        let error = resolve_stable_by_id(
            &fixture.state,
            ID,
            None,
            PathLock::Release,
            not_found,
            |_| async {
                Err::<(), _>(AttemptError::Vanished(ApiError::not_found(
                    "page file missing: notes/a.md",
                )))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.error, "page file missing: notes/a.md");
    }

    #[tokio::test]
    async fn a_failed_attempt_is_not_retried() {
        let fixture = fixture().await;
        let calls = Mutex::new(0);
        let error = resolve_stable_by_id(
            &fixture.state,
            ID,
            None,
            PathLock::Release,
            not_found,
            |_| {
                *calls.lock() += 1;
                async { Err::<(), _>(AttemptError::Failed(ApiError::bad_request("nope"))) }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(*calls.lock(), 1);
    }

    #[tokio::test]
    async fn an_unknown_id_or_kind_mismatch_is_not_found() {
        let fixture = fixture().await;
        for kind in [None, Some(Kind::Cycle)] {
            let id = if kind.is_none() { "unknown" } else { ID };
            let error = resolve_stable_by_id(
                &fixture.state,
                id,
                kind,
                PathLock::Hold,
                || ApiError::not_found("cycle not found"),
                |_| async { Ok::<_, AttemptError>(()) },
            )
            .await
            .unwrap_err();
            assert_eq!(error.status, 404);
            assert_eq!(error.error, "cycle not found");
        }
    }

    #[tokio::test]
    async fn a_page_that_never_settles_fails_after_the_attempt_budget() {
        let fixture = fixture().await;
        let calls = Mutex::new(0usize);
        let error = resolve_stable_by_id(
            &fixture.state,
            ID,
            None,
            PathLock::Release,
            not_found,
            |path| {
                let n = {
                    let mut calls = calls.lock();
                    *calls += 1;
                    *calls
                };
                let fixture = &fixture;
                async move {
                    fixture
                        .relocate(path.as_str(), &format!("moves/{n}.md"))
                        .await;
                    Err::<(), _>(AttemptError::Vanished(ApiError::not_found("gone")))
                }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 500);
        assert_eq!(
            error.error,
            format!("page path did not stabilize for id: {ID}")
        );
        assert_eq!(*calls.lock(), BY_ID_PATH_ATTEMPTS);
    }

    #[tokio::test]
    async fn read_page_once_returns_the_guard_bytes_meta_and_body() {
        let fixture = fixture().await;
        let path = VaultPath::new("notes/a.md").unwrap();
        let (expected, meta, body) =
            read_page_once(&fixture.state, &path, MissingFile::Conflict).unwrap();
        assert_eq!(
            expected,
            fs::read_to_string(fixture.state.vault.resolve(&path)).unwrap()
        );
        assert_eq!(meta.id.to_string(), ID);
        assert_eq!(body, "body\n");
    }

    #[tokio::test]
    async fn read_page_once_applies_the_missing_file_policy() {
        let fixture = fixture().await;
        let path = VaultPath::new("notes/gone.md").unwrap();
        for (missing, status, message) in [
            (
                MissingFile::Conflict,
                409,
                "page changed during mutation: notes/gone.md",
            ),
            (MissingFile::NotFound, 404, "page not found: notes/gone.md"),
        ] {
            let Err(AttemptError::Vanished(error)) = read_page_once(&fixture.state, &path, missing)
            else {
                panic!("a missing file is a vanished page");
            };
            assert_eq!(error.status, status);
            assert_eq!(error.error, message);
        }
    }

    #[test]
    fn an_attempt_error_unwraps_to_its_api_error() {
        let error: ApiError = AttemptError::Vanished(ApiError::conflict("x")).into();
        assert_eq!(error.status, 409);
        let error: ApiError = AttemptError::Failed(ApiError::bad_request("y")).into();
        assert_eq!(error.status, 400);
    }

    #[test]
    fn only_a_not_found_error_counts_as_vanished() {
        assert!(matches!(
            AttemptError::vanished_if_not_found(ApiError::not_found("x")),
            AttemptError::Vanished(_)
        ));
        assert!(matches!(
            AttemptError::vanished_if_not_found(ApiError::conflict("x")),
            AttemptError::Failed(_)
        ));
    }
}
