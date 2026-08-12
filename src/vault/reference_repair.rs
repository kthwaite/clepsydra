use std::fs;

use thiserror::Error;

use super::Vault;
use super::batch_mutation::{BatchMutationCommand, BatchPathIntent, ExpectedPathState};
use super::index::{IndexError, VaultIndex};
use super::link::{LinkKind, extract_links};
use super::mutation::{MutationPlan, PlannedTextEdit};
use super::page::{PageMeta, body_offset, page_revision, parse_or_repair_frontmatter, write_page_content};
use super::path::VaultPath;
use super::reference_issues::{
    ReferenceIssue, ReferenceIssueAction, ReferenceIssueFilter, ReferenceIssueKind,
};
use super::sync::ChangeEvent;
use super::toml_json::toml_value_to_json;
use super::toml_patch::{FrontmatterEdits, SpliceError, splice_frontmatter};

#[derive(Debug, Clone)]
pub enum ReferenceRepairAction {
    Create { folder: String, body: Option<String> },
    Replace { candidate_page_id: String },
}

#[derive(Debug, Clone)]
pub struct ReferenceRepairRequest {
    pub fingerprint: String,
    pub source_revision: String,
    pub action: ReferenceRepairAction,
}

#[derive(Debug)]
pub struct PreparedReferenceRepair {
    pub fingerprint: String,
    pub before: String,
    pub after: String,
    pub plan: MutationPlan,
    pub command: BatchMutationCommand,
}

#[derive(Debug, Error)]
pub enum ReferenceRepairError {
    #[error("reference repair request is invalid: {0}")]
    Invalid(String),
    #[error("reference issue is no longer current")]
    Stale,
    #[error("reference issue projection failed: {0}")]
    Index(#[from] IndexError),
    #[error("reference repair source could not be read: {0}")]
    Io(#[from] std::io::Error),
}

pub fn prepare_reference_repair(
    vault: &Vault,
    index: &VaultIndex,
    request: ReferenceRepairRequest,
) -> Result<PreparedReferenceRepair, ReferenceRepairError> {
    let issue = current_issue(index, &request.fingerprint)?.ok_or(ReferenceRepairError::Stale)?;
    if issue.source_revision != request.source_revision {
        return Err(ReferenceRepairError::Stale);
    }

    let required_action = match &request.action {
        ReferenceRepairAction::Create { .. } => ReferenceIssueAction::Create,
        ReferenceRepairAction::Replace { .. } => ReferenceIssueAction::Replace,
    };
    if !issue.actions.contains(&required_action) {
        return Err(ReferenceRepairError::Invalid(
            "the requested action is unavailable for this issue".to_string(),
        ));
    }

    let source_path = VaultPath::new(&issue.source_path)
        .map_err(|error| ReferenceRepairError::Invalid(error.to_string()))?;
    let source_absolute = vault.resolve(&source_path);
    let source = match fs::read_to_string(&source_absolute) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReferenceRepairError::Stale);
        }
        Err(error) => return Err(ReferenceRepairError::Io(error)),
    };
    if page_revision(&source) != request.source_revision {
        return Err(ReferenceRepairError::Stale);
    }

    match request.action {
        ReferenceRepairAction::Create { folder, body } => {
            prepare_create(vault, index, issue, source_path, source, folder, body)
        }
        ReferenceRepairAction::Replace { candidate_page_id } => prepare_replace(
            index,
            issue,
            source_path,
            source,
            &candidate_page_id,
        ),
    }
}

fn current_issue(
    index: &VaultIndex,
    fingerprint: &str,
) -> Result<Option<ReferenceIssue>, IndexError> {
    let page = index.reference_issues(ReferenceIssueFilter {
        limit: u32::MAX,
        ..ReferenceIssueFilter::default()
    })?;
    Ok(page
        .items
        .into_iter()
        .find(|issue| issue.fingerprint == fingerprint))
}

fn prepare_create(
    vault: &Vault,
    index: &VaultIndex,
    issue: ReferenceIssue,
    source_path: VaultPath,
    source: String,
    folder: String,
    body: Option<String>,
) -> Result<PreparedReferenceRepair, ReferenceRepairError> {
    if issue.kind != ReferenceIssueKind::UnresolvedPageLink {
        return Err(ReferenceRepairError::Invalid(
            "only unresolved page links can create a target".to_string(),
        ));
    }
    let target = issue.target_raw.as_deref().ok_or_else(|| {
        ReferenceRepairError::Invalid("issue has no repairable target".to_string())
    })?;
    let (before, _) = body_link_context(&issue, &source)?;

    let mut destination = VaultPath::from_title(target);
    if !folder.is_empty() {
        let combined = format!(
            "{}/{}",
            folder.trim_end_matches('/'),
            destination.as_str()
        );
        destination = VaultPath::new(&combined)
            .map_err(|error| ReferenceRepairError::Invalid(error.to_string()))?;
    }
    if destination == source_path {
        return Err(ReferenceRepairError::Invalid(
            "created target would overwrite the source page".to_string(),
        ));
    }

    let timestamp = source_timestamp(index, &issue.source_id)?;
    let mut meta = PageMeta::new();
    meta.id = deterministic_page_id(&issue.fingerprint, timestamp);
    meta.title = Some(target.to_string());
    meta.created_at = Some(timestamp);
    meta.updated_at = Some(timestamp);
    let created = write_page_content(&meta, body.as_deref().unwrap_or_default()).into_bytes();

    let mut plan = MutationPlan::empty();
    plan.stage_create_file(vault, destination.clone(), created)?;
    plan.staged_writes.push(super::mutation::StagedWrite {
        path: vault.resolve(&source_path),
        expected_bytes: source.as_bytes().to_vec(),
        content: source,
    });
    plan.index_events = vec![
        ChangeEvent::Upsert(destination),
        ChangeEvent::Upsert(source_path),
    ];
    let command = plan.clone().into_batch_command(vault)?;

    Ok(PreparedReferenceRepair {
        fingerprint: issue.fingerprint,
        before: before.clone(),
        after: before,
        plan,
        command,
    })
}

fn prepare_replace(
    index: &VaultIndex,
    issue: ReferenceIssue,
    source_path: VaultPath,
    source: String,
    candidate_page_id: &str,
) -> Result<PreparedReferenceRepair, ReferenceRepairError> {
    let candidate = issue
        .candidates
        .iter()
        .find(|candidate| candidate.page_id == candidate_page_id)
        .ok_or_else(|| {
            ReferenceRepairError::Invalid(
                "candidate_page_id is not a current candidate for this issue".to_string(),
            )
        })?;

    let explicit_target = if issue.kind == ReferenceIssueKind::BrokenBlockRef {
        let target = issue.target_raw.as_deref().ok_or_else(|| {
            ReferenceRepairError::Invalid("block issue has no current block ID".to_string())
        })?;
        let count: i64 = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM blocks WHERE page_id = ?1 AND block_id = ?2",
                rusqlite::params![candidate.page_id, target],
                |row| row.get(0),
            )
            .map_err(IndexError::Sqlite)?;
        if count != 1 || issue.candidates.len() != 1 {
            return Err(ReferenceRepairError::Invalid(
                "block repair requires exactly one current block-ID candidate".to_string(),
            ));
        }
        target.to_string()
    } else {
        candidate.path.clone()
    };

    let (before, after, content) = if issue.kind == ReferenceIssueKind::InvalidRelationTarget {
        replace_property_reference(&issue, &source, &explicit_target)?
    } else {
        replace_body_reference(&issue, &source, &explicit_target)?
    };

    let mut plan = MutationPlan::empty();
    plan.text_edits.push(PlannedTextEdit {
        path: source_path.as_str().to_string(),
        old_text: before.clone(),
        new_text: after.clone(),
    });
    plan.index_events = vec![ChangeEvent::Upsert(source_path.clone())];

    let command = BatchMutationCommand {
        intents: vec![BatchPathIntent::Write {
            path: source_path,
            expected: ExpectedPathState::Bytes(source.as_bytes().to_vec()),
            content: content.into_bytes(),
        }],
        create_directories: Vec::new(),
        remove_directories: Vec::new(),
        index_events: plan.index_events.clone(),
        moved_pages: Vec::new(),
    };


    Ok(PreparedReferenceRepair {
        fingerprint: issue.fingerprint,
        before,
        after,
        plan,
        command,
    })
}

fn body_link_context(
    issue: &ReferenceIssue,
    source: &str,
) -> Result<(String, std::ops::Range<usize>), ReferenceRepairError> {
    let start = usize::try_from(issue.span_start.ok_or_else(|| {
        ReferenceRepairError::Invalid("issue has no source span".to_string())
    })?)
    .map_err(|_| ReferenceRepairError::Invalid("invalid source span".to_string()))?;
    let end = usize::try_from(issue.span_end.ok_or_else(|| {
        ReferenceRepairError::Invalid("issue has no source span".to_string())
    })?)
    .map_err(|_| ReferenceRepairError::Invalid("invalid source span".to_string()))?;
    if start == 0 || end <= start {
        return Err(ReferenceRepairError::Invalid(
            "source span is not a positive body span".to_string(),
        ));
    }
    let body_start = body_offset(source);
    let body = source.get(body_start..).ok_or_else(|| {
        ReferenceRepairError::Invalid("source body is not addressable".to_string())
    })?;
    let target = issue.target_raw.as_deref().ok_or_else(|| {
        ReferenceRepairError::Invalid("issue has no repairable target".to_string())
    })?;
    let link = extract_links(body)
        .into_iter()
        .find(|link| link.span == (start..end) && link.target_raw == target)
        .ok_or(ReferenceRepairError::Stale)?;
    if !matches!(link.kind, LinkKind::Wiki | LinkKind::BlockRef) {
        return Err(ReferenceRepairError::Invalid(
            "source span is not a repairable reference".to_string(),
        ));
    }
    let absolute = (body_start + start)..(body_start + end);
    let context = source
        .get(absolute.clone())
        .ok_or(ReferenceRepairError::Stale)?
        .to_string();
    Ok((context, absolute))
}

fn replace_body_reference(
    issue: &ReferenceIssue,
    source: &str,
    explicit_target: &str,
) -> Result<(String, String, String), ReferenceRepairError> {
    let (before, range) = body_link_context(issue, source)?;
    let old_target = issue.target_raw.as_deref().ok_or_else(|| {
        ReferenceRepairError::Invalid("issue has no repairable target".to_string())
    })?;
    let after = replace_reference_target(&before, old_target, explicit_target)?;
    let mut content = source.to_string();
    content.replace_range(range, &after);
    Ok((before, after, content))
}

fn replace_property_reference(
    issue: &ReferenceIssue,
    source: &str,
    explicit_target: &str,
) -> Result<(String, String, String), ReferenceRepairError> {
    let field = issue.source_field.as_deref().ok_or_else(|| {
        ReferenceRepairError::Invalid("property issue has no source field".to_string())
    })?;
    let old_target = issue.target_raw.as_deref().ok_or_else(|| {
        ReferenceRepairError::Invalid("property issue has no target".to_string())
    })?;
    let (meta, body, _, warning) = parse_or_repair_frontmatter(source);
    if warning.is_some() {
        return Err(ReferenceRepairError::Invalid(
            "source frontmatter cannot be patched safely".to_string(),
        ));
    }
    let mut value = match field {
        "tags" => toml::Value::Array(
            meta.tags
                .iter()
                .cloned()
                .map(toml::Value::String)
                .collect(),
        ),
        "aliases" => toml::Value::Array(
            meta.aliases
                .iter()
                .cloned()
                .map(toml::Value::String)
                .collect(),
        ),
        _ => meta
            .extra
            .get(field)
            .cloned()
            .ok_or(ReferenceRepairError::Stale)?,
    };
    let mut replacements = 0_usize;
    let mut before = None;
    let mut after = None;
    rewrite_property_value(
        &mut value,
        old_target,
        explicit_target,
        &mut replacements,
        &mut before,
        &mut after,
    )?;
    if replacements != 1 {
        return Err(ReferenceRepairError::Invalid(
            "property repair requires exactly one matching current value".to_string(),
        ));
    }
    let edits = FrontmatterEdits {
        set: vec![(field.to_string(), toml_value_to_json(&value), None)],
        ..FrontmatterEdits::default()
    };
    let content = match splice_frontmatter(source, &edits) {
        Ok(content) => content,
        Err(SpliceError::LegacyFrontmatter) => {
            let healed = write_page_content(&meta, &body);
            splice_frontmatter(&healed, &edits).map_err(|error| {
                ReferenceRepairError::Invalid(format!("property cannot be patched: {error}"))
            })?
        }
        Err(error) => {
            return Err(ReferenceRepairError::Invalid(format!(
                "property cannot be patched: {error}"
            )));
        }
    };
    Ok((
        format!("{field}: {}", before.unwrap_or_default()),
        format!("{field}: {}", after.unwrap_or_default()),
        content,
    ))
}

fn rewrite_property_value(
    value: &mut toml::Value,
    old_target: &str,
    explicit_target: &str,
    replacements: &mut usize,
    before: &mut Option<String>,
    after: &mut Option<String>,
) -> Result<(), ReferenceRepairError> {
    let mut rewrite = |text: &mut String| -> Result<(), ReferenceRepairError> {
        let extracted = super::link::extract_property_refs("property", std::slice::from_ref(text));
        if extracted.first().is_some_and(|link| link.target_raw == old_target) {
            let replacement = replace_reference_target(text, old_target, explicit_target)?;
            *replacements += 1;
            if before.is_none() {
                *before = Some(text.clone());
                *after = Some(replacement.clone());
            }
            *text = replacement;
        }
        Ok(())
    };
    match value {
        toml::Value::String(text) => rewrite(text),
        toml::Value::Array(items) => {
            for item in items {
                if let toml::Value::String(text) = item {
                    rewrite(text)?;
                }
            }
            Ok(())
        }
        _ => Err(ReferenceRepairError::Invalid(
            "relation property is not a string or string array".to_string(),
        )),
    }
}

fn replace_reference_target(
    reference: &str,
    old_target: &str,
    explicit_target: &str,
) -> Result<String, ReferenceRepairError> {
    if let Some(inner) = reference
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
    {
        let (target, display) = inner
            .split_once('|')
            .map_or((inner, None), |(target, display)| (target, Some(display)));
        if target != old_target {
            return Err(ReferenceRepairError::Stale);
        }
        return Ok(match display {
            Some(display) => format!("[[{explicit_target}|{display}]]"),
            None => format!("[[{explicit_target}]]"),
        });
    }
    if let Some(inner) = reference
        .strip_prefix("((")
        .and_then(|value| value.strip_suffix("))"))
    {
        if inner != old_target {
            return Err(ReferenceRepairError::Stale);
        }
        return Ok(format!("(({explicit_target}))"));
    }
    if reference.trim() == old_target {
        let prefix = &reference[..reference.len() - reference.trim_start().len()];
        let suffix = &reference[reference.trim_end().len()..];
        return Ok(format!("{prefix}{explicit_target}{suffix}"));
    }
    Err(ReferenceRepairError::Stale)
}

fn source_timestamp(
    index: &VaultIndex,
    source_id: &str,
) -> Result<chrono::DateTime<chrono::Utc>, ReferenceRepairError> {
    let (updated_at, created_at): (Option<String>, Option<String>) = index
        .connection()
        .query_row(
            "SELECT updated_at, created_at FROM pages WHERE id = ?1",
            [source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(IndexError::Sqlite)?;
    updated_at
        .or(created_at)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&chrono::Utc))
        .ok_or_else(|| {
            ReferenceRepairError::Invalid(
                "source page has no stable timestamp for deterministic creation".to_string(),
            )
        })
}

fn deterministic_page_id(
    fingerprint: &str,
    timestamp: chrono::DateTime<chrono::Utc>,
) -> uuid::Uuid {
    let digest = blake3::hash(format!("reference-repair-create\0{fingerprint}").as_bytes());
    let mut bytes = [0_u8; 16];
    let millis = u64::try_from(timestamp.timestamp_millis()).unwrap_or_default();
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    bytes[6..].copy_from_slice(&digest.as_bytes()[..10]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes)
}
