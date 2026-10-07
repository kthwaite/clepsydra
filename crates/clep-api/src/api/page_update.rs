//! The page update planner: the rules behind `PUT /pages/{path}` and
//! `PUT /pages/by-id/{uuid}`, behind one pure interface.
//!
//! [`plan_page_update`] takes the page as read from disk and the request,
//! checks identity, revision and age armor, and merges the optional fields.
//! It touches neither the filesystem nor the clock; the handler reads the
//! page and passes `now`.

use chrono::{DateTime, Utc};

use crate::api::error::ApiError;
use crate::api::pages::UpdatePageRequest;
use crate::vault::encryption::validate_age_armor;
use crate::vault::mutation_coordinator::{ProjectAssignment, UpdatePageCommand};
use crate::vault::page::{Page, page_revision};

/// Refuse a page that is not the one `expected_uuid` names: the id's page
/// moved away and another page now sits at its old path.
pub(crate) fn check_identity(page: &Page, expected_uuid: Option<&str>) -> Result<(), ApiError> {
    match expected_uuid {
        Some(uuid) if page.meta.id.to_string() != uuid => Err(ApiError::not_found(format!(
            "page moved while resolving id: {uuid}"
        ))),
        _ => Ok(()),
    }
}

/// Refuse a page whose revision is not `expected_revision`.
pub(crate) fn check_revision(page: &Page, expected_revision: &str) -> Result<(), ApiError> {
    let current_revision = page_revision(&page.raw_content);
    if current_revision != expected_revision {
        return Err(ApiError::revision_conflict(current_revision));
    }
    Ok(())
}

/// Plan an update of `page`. Rules, in order: the page is the one
/// `expected_uuid` names (404 otherwise); its revision is the expected one
/// (409 with the current revision otherwise); a new body for a protected
/// page is canonical age armor (400 otherwise). Then every present field
/// replaces the page's own; absent fields are kept. `updated_at` becomes
/// `now`. `page.raw_content` is the stale-write guard.
pub(crate) fn plan_page_update(
    page: Page,
    body: UpdatePageRequest,
    expected_uuid: Option<&str>,
    now: DateTime<Utc>,
) -> Result<UpdatePageCommand, ApiError> {
    check_identity(&page, expected_uuid)?;
    check_revision(&page, &body.expected_revision)?;
    if page.is_encrypted()
        && let Some(new_body) = body.body.as_deref()
    {
        validate_age_armor(new_body).map_err(|error| {
            ApiError::bad_request(format!(
                "protected page body must remain canonical age armor: {error}"
            ))
        })?;
    }

    let Page {
        path,
        mut meta,
        body: page_body,
        raw_content,
    } = page;
    if let Some(title) = body.title {
        meta.title = Some(title);
    }
    if let Some(tags) = body.tags {
        meta.tags = tags;
    }
    if let Some(aliases) = body.aliases {
        meta.aliases = aliases;
    }
    if let Some(readonly) = body.readonly {
        meta.readonly = Some(readonly);
    }
    meta.updated_at = Some(now);
    Ok(UpdatePageCommand {
        path,
        expected_content: raw_content,
        meta,
        body: body.body.unwrap_or(page_body),
        project: ProjectAssignment::Unchanged,
        reconcile: false,
    })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;
    use crate::vault::page::parse_frontmatter;
    use crate::vault::path::VaultPath;

    const ID: &str = "019fd000-0000-7000-8000-000000000001";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 7, 12, 0, 0).unwrap()
    }

    fn page_from(raw: String) -> Page {
        let (meta, body) = parse_frontmatter(&raw).unwrap();
        Page {
            path: VaultPath::new("notes/plan.md").unwrap(),
            meta,
            body,
            raw_content: raw,
        }
    }

    fn page() -> Page {
        page_from(format!(
            "+++\nid = \"{ID}\"\ntitle = \"Plan\"\ntags = [\"a\"]\naliases = [\"p\"]\n+++\nold body\n"
        ))
    }

    fn protected_page() -> Page {
        page_from(format!(
            "+++\nid = \"{ID}\"\ntitle = \"Plan\"\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\n+++\n{}",
            clep_test_support::PRIVATE_NOTE_AGE
        ))
    }

    fn request(page: &Page, fields: serde_json::Value) -> UpdatePageRequest {
        let mut body = json!({ "expected_revision": page_revision(&page.raw_content) });
        body.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        serde_json::from_value(body).unwrap()
    }

    fn plan(page: Page, fields: serde_json::Value) -> Result<UpdatePageCommand, ApiError> {
        let body = request(&page, fields);
        plan_page_update(page, body, Some(ID), now())
    }

    #[test]
    fn absent_fields_are_kept() {
        let original = page();
        let (path, raw, old_body) = (
            original.path.clone(),
            original.raw_content.clone(),
            original.body.clone(),
        );
        let command = plan(original, json!({})).unwrap();
        assert_eq!(command.path, path);
        assert_eq!(command.expected_content, raw);
        assert_eq!(command.meta.title.as_deref(), Some("Plan"));
        assert_eq!(command.meta.tags, ["a"]);
        assert_eq!(command.meta.aliases, ["p"]);
        assert_eq!(command.meta.readonly, None);
        assert_eq!(command.body, old_body);
        assert_eq!(command.meta.updated_at, Some(now()));
        assert_eq!(command.project, ProjectAssignment::Unchanged);
        assert!(!command.reconcile);
    }

    #[test]
    fn present_fields_are_set() {
        let command = plan(
            page(),
            json!({
                "title": "Renamed",
                "tags": ["b", "c"],
                "aliases": ["q"],
                "readonly": true,
                "body": "new body\n"
            }),
        )
        .unwrap();
        assert_eq!(command.meta.title.as_deref(), Some("Renamed"));
        assert_eq!(command.meta.tags, ["b", "c"]);
        assert_eq!(command.meta.aliases, ["q"]);
        assert_eq!(command.meta.readonly, Some(true));
        assert_eq!(command.body, "new body\n");
    }

    #[test]
    fn empty_values_clear_the_lists_and_body() {
        let command = plan(
            page(),
            json!({ "tags": [], "aliases": [], "body": "", "readonly": false }),
        )
        .unwrap();
        assert!(command.meta.tags.is_empty());
        assert!(command.meta.aliases.is_empty());
        assert_eq!(command.body, "");
        assert_eq!(command.meta.readonly, Some(false));
    }

    #[test]
    fn a_revision_mismatch_is_a_revision_conflict() {
        let original = page();
        let mut body = request(&original, json!({ "title": "x" }));
        body.expected_revision = "stale".into();
        let current = page_revision(&original.raw_content);
        let error = plan_page_update(original, body, Some(ID), now()).unwrap_err();
        assert_eq!(error.status, 409);
        assert_eq!(error.detail.unwrap()["current_revision"], current);
    }

    #[test]
    fn another_pages_id_reads_as_moved() {
        let original = page();
        let other = "019fd000-0000-7000-8000-0000000000ff";
        let body = request(&original, json!({}));
        let error = plan_page_update(original, body, Some(other), now()).unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(
            error.error,
            format!("page moved while resolving id: {other}")
        );
    }

    #[test]
    fn a_path_update_checks_no_identity() {
        let original = page();
        let body = request(&original, json!({}));
        assert!(plan_page_update(original, body, None, now()).is_ok());
    }

    #[test]
    fn identity_is_checked_before_revision() {
        let original = page();
        let mut body = request(&original, json!({}));
        body.expected_revision = "stale".into();
        let error = plan_page_update(original, body, Some("other"), now()).unwrap_err();
        assert_eq!(error.status, 404);
    }

    #[test]
    fn a_protected_page_body_must_stay_age_armor() {
        let error = plan(protected_page(), json!({ "body": "plain text" })).unwrap_err();
        assert_eq!(error.status, 400);
        assert!(
            error
                .error
                .starts_with("protected page body must remain canonical age armor: "),
            "{}",
            error.error
        );

        let command = plan(
            protected_page(),
            json!({ "body": clep_test_support::PRIVATE_NOTE_AGE }),
        )
        .unwrap();
        assert_eq!(command.body, clep_test_support::PRIVATE_NOTE_AGE);
        assert!(plan(protected_page(), json!({ "title": "x" })).is_ok());
    }

    #[test]
    fn an_unprotected_page_takes_any_body() {
        assert!(plan(page(), json!({ "body": "-----BEGIN nonsense" })).is_ok());
    }
}
