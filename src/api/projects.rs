//! Project existence checks shared by every write path that sets `project`.
//!
//! A project exists when some PROJECT page declares its slug. Task
//! create/patch, page create, and page assignment all refuse a slug no
//! PROJECT page declares; the PROJECT page itself is what defines a project,
//! so it may declare any well-formed slug.

use rusqlite::params;

use super::AppState;
use super::error::ApiError;
use crate::vault::kind::Kind;

/// Whether `slug` is declared as the `project` of at least one PROJECT page.
pub(crate) async fn project_exists(state: &AppState, slug: &str) -> Result<bool, ApiError> {
    let slug_owned = slug.to_string();
    state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .prepare("SELECT 1 FROM pages WHERE kind = ?1 AND project = ?2 LIMIT 1")?
                .exists(params![Kind::Project.as_str(), slug_owned])
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// The 400 every write path returns for a `project` no PROJECT page declares.
pub(crate) fn unknown_project(slug: &str) -> ApiError {
    ApiError::bad_request(format!(
        "unknown project: {slug}; must match the project slug declared by an existing PROJECT page"
    ))
}

/// Check that `slug` is well-formed and declared as the `project` of at least
/// one PROJECT page. Returns 400 otherwise. Callers only pass a non-empty slug
/// (the empty string clears on a task PATCH).
///
/// Shape comes first, because a PROJECT page authored by hand in the vault can
/// declare a slug no API write path would have accepted. Existence alone would
/// let such a slug through here while `validate_project_slug` refused it on
/// assign, so the two paths would disagree about the same project.
pub(crate) async fn ensure_project_exists(state: &AppState, slug: &str) -> Result<(), ApiError> {
    super::pages::validate_project_slug(slug).map_err(ApiError::bad_request)?;
    if project_exists(state, slug).await? {
        Ok(())
    } else {
        Err(unknown_project(slug))
    }
}
