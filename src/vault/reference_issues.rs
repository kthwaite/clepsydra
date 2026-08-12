use rusqlite::{Connection, named_params};

use super::index::IndexError;
use super::kind::Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceIssueKind {
    UnresolvedPageLink,
    AmbiguousPageLink,
    BrokenBlockRef,
    InvalidRelationTarget,
    OrphanPage,
    IsolatedPage,
}

impl ReferenceIssueKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::UnresolvedPageLink => "unresolved_page_link",
            Self::AmbiguousPageLink => "ambiguous_page_link",
            Self::BrokenBlockRef => "broken_block_ref",
            Self::InvalidRelationTarget => "invalid_relation_target",
            Self::OrphanPage => "orphan_page",
            Self::IsolatedPage => "isolated_page",
        }
    }

    fn from_str(value: &str) -> Result<Self, IndexError> {
        match value {
            "unresolved_page_link" => Ok(Self::UnresolvedPageLink),
            "ambiguous_page_link" => Ok(Self::AmbiguousPageLink),
            "broken_block_ref" => Ok(Self::BrokenBlockRef),
            "invalid_relation_target" => Ok(Self::InvalidRelationTarget),
            "orphan_page" => Ok(Self::OrphanPage),
            "isolated_page" => Ok(Self::IsolatedPage),
            _ => Err(IndexError::Other(format!(
                "unknown projected reference issue kind: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceIssueAction {
    Create,
    Replace,
    OpenSource,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceCandidate {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceIssue {
    pub fingerprint: String,
    pub kind: ReferenceIssueKind,
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    pub source_revision: String,
    pub span_start: Option<i64>,
    pub span_end: Option<i64>,
    pub source_field: Option<String>,
    pub snippet: Option<String>,
    pub target_raw: Option<String>,
    pub candidates: Vec<ReferenceCandidate>,
    pub actions: Vec<ReferenceIssueAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceIssueFilter {
    pub kinds: Vec<ReferenceIssueKind>,
    pub project: Option<String>,
    pub page_kind: Option<Kind>,
    pub actionable: Option<bool>,
    pub limit: u32,
    pub offset: u32,
}

impl Default for ReferenceIssueFilter {
    fn default() -> Self {
        Self {
            kinds: Vec::new(),
            project: None,
            page_kind: None,
            actionable: None,
            limit: 50,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceIssuePage {
    pub items: Vec<ReferenceIssue>,
    pub total: u64,
}

const PROJECTION_SQL: &str = r#"
WITH unresolved_links AS (
    SELECT
        p.id AS source_id,
        p.path AS source_path,
        p.title AS source_title,
        p.content_hash AS source_revision,
        p.encrypted,
        p.kind AS page_kind,
        p.project,
        l.target_raw,
        l.target_canonical,
        l.target_block_id,
        l.kind AS link_kind,
        l.source_field,
        l.span_start,
        l.span_end,
        CASE
            WHEN p.encrypted = 0
             AND l.kind != 'property_ref'
             AND l.span_start > 0
            THEN (
                SELECT body
                FROM pages_fts
                WHERE page_id = p.id
                LIMIT 1
            )
            ELSE NULL
        END AS body,
        (
            SELECT COUNT(DISTINCT cn.page_id)
            FROM canonical_names cn
            WHERE cn.canonical_name = l.target_canonical
        ) AS canonical_candidate_count,
        (
            SELECT COUNT(*)
            FROM blocks b
            WHERE b.block_id = l.target_block_id
        ) AS block_candidate_count
    FROM links l
    JOIN pages p ON p.id = l.source_id
    WHERE l.target_id IS NULL
      AND l.kind IN ('wiki', 'block_ref', 'property_ref')
),
link_issues AS (
    SELECT
        CASE
            WHEN link_kind = 'block_ref' THEN 'broken_block_ref'
            WHEN link_kind = 'property_ref' THEN 'invalid_relation_target'
            WHEN canonical_candidate_count >= 2 THEN 'ambiguous_page_link'
            ELSE 'unresolved_page_link'
        END AS issue_kind,
        CASE
            WHEN link_kind = 'block_ref' THEN 0
            WHEN link_kind = 'property_ref' THEN 1
            WHEN canonical_candidate_count < 2 THEN 2
            ELSE 3
        END AS severity,
        source_id,
        source_path,
        source_title,
        source_revision,
        encrypted,
        page_kind,
        project,
        span_start,
        span_end,
        source_field,
        body,
        target_raw,
        target_canonical,
        target_block_id,
        CASE
            WHEN encrypted != 0 AND link_kind IN ('wiki', 'block_ref') THEN 0
            WHEN link_kind = 'wiki' THEN 1
            WHEN link_kind = 'property_ref' AND canonical_candidate_count > 0 THEN 1
            WHEN link_kind = 'block_ref' AND block_candidate_count = 1 THEN 1
            ELSE 0
        END AS actionable
    FROM unresolved_links
),
topology_issues AS (
    SELECT
        CASE
            WHEN p.encrypted = 0
             AND NOT EXISTS (
                SELECT 1
                FROM links outbound
                WHERE outbound.source_id = p.id
                  AND outbound.target_id IS NOT NULL
            ) THEN 'isolated_page'
            ELSE 'orphan_page'
        END AS issue_kind,
        CASE
            WHEN p.encrypted = 0
             AND NOT EXISTS (
                SELECT 1
                FROM links outbound
                WHERE outbound.source_id = p.id
                  AND outbound.target_id IS NOT NULL
            ) THEN 5
            ELSE 4
        END AS severity,
        p.id AS source_id,
        p.path AS source_path,
        p.title AS source_title,
        p.content_hash AS source_revision,
        p.encrypted,
        p.kind AS page_kind,
        p.project,
        NULL AS span_start,
        NULL AS span_end,
        NULL AS source_field,
        NULL AS body,
        NULL AS target_raw,
        NULL AS target_canonical,
        NULL AS target_block_id,
        0 AS actionable
    FROM pages p
    WHERE NOT EXISTS (
        SELECT 1
        FROM links inbound
        WHERE inbound.target_id = p.id
    )
),
issues AS (
    SELECT * FROM link_issues
    UNION ALL
    SELECT * FROM topology_issues
),
filtered AS (
    SELECT *
    FROM issues
    WHERE (
        :all_kinds = 1
        OR (issue_kind = 'unresolved_page_link' AND :unresolved_page_link = 1)
        OR (issue_kind = 'ambiguous_page_link' AND :ambiguous_page_link = 1)
        OR (issue_kind = 'broken_block_ref' AND :broken_block_ref = 1)
        OR (issue_kind = 'invalid_relation_target' AND :invalid_relation_target = 1)
        OR (issue_kind = 'orphan_page' AND :orphan_page = 1)
        OR (issue_kind = 'isolated_page' AND :isolated_page = 1)
    )
      AND (:project IS NULL OR project = :project)
      AND (:page_kind IS NULL OR page_kind = :page_kind)
      AND (:actionable < 0 OR actionable = :actionable)
),
page_items AS (
    SELECT *
    FROM filtered
    ORDER BY
        severity,
        source_path,
        COALESCE(span_start, -9223372036854775808),
        COALESCE(target_raw, '')
    LIMIT :limit OFFSET :offset
),
candidate_base AS (
    SELECT
        pi.issue_kind,
        pi.source_id,
        pi.span_start,
        candidate.id AS page_id,
        candidate.path,
        candidate.title,
        'canonical_name' AS rationale
    FROM page_items pi
    JOIN canonical_names cn ON cn.canonical_name = pi.target_canonical
    JOIN pages candidate ON candidate.id = cn.page_id
    WHERE pi.issue_kind IN (
        'unresolved_page_link',
        'ambiguous_page_link',
        'invalid_relation_target'
    )
      AND (pi.encrypted = 0 OR pi.issue_kind = 'invalid_relation_target')

    UNION

    SELECT
        pi.issue_kind,
        pi.source_id,
        pi.span_start,
        candidate.id AS page_id,
        candidate.path,
        candidate.title,
        'block_id' AS rationale
    FROM page_items pi
    JOIN blocks b ON b.block_id = pi.target_block_id
    JOIN pages candidate ON candidate.id = b.page_id
    WHERE pi.issue_kind = 'broken_block_ref'
      AND pi.encrypted = 0
),
candidate_rows AS (
    SELECT
        issue_kind,
        source_id,
        span_start,
        page_id,
        path,
        title,
        rationale,
        ROW_NUMBER() OVER (
            PARTITION BY issue_kind, source_id, span_start
            ORDER BY path, page_id
        ) AS candidate_rank
    FROM candidate_base
),
all_rows AS (
    SELECT
        (SELECT COUNT(*) FROM filtered) AS total,
        pi.issue_kind,
        pi.source_id,
        pi.source_path,
        pi.source_title,
        pi.source_revision,
        pi.span_start,
        pi.span_end,
        pi.source_field,
        pi.body,
        pi.target_raw,
        pi.encrypted,
        pi.actionable,
        cr.page_id AS candidate_id,
        cr.path AS candidate_path,
        cr.title AS candidate_title,
        cr.rationale AS candidate_rationale,
        COALESCE(cr.candidate_rank, 0) AS candidate_rank,
        pi.severity,
        COALESCE(pi.span_start, -9223372036854775808) AS order_span,
        COALESCE(pi.target_raw, '') AS order_target,
        0 AS sentinel
    FROM page_items pi
    LEFT JOIN candidate_rows cr
      ON cr.issue_kind = pi.issue_kind
     AND cr.source_id = pi.source_id
     AND cr.span_start IS pi.span_start

    UNION ALL

    SELECT
        (SELECT COUNT(*) FROM filtered),
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        0, 0, 0, '', 1
    WHERE NOT EXISTS (SELECT 1 FROM page_items)
)
SELECT
    total,
    issue_kind,
    source_id,
    source_path,
    source_title,
    source_revision,
    span_start,
    span_end,
    source_field,
    body,
    target_raw,
    encrypted,
    actionable,
    candidate_id,
    candidate_path,
    candidate_title,
    candidate_rationale
FROM all_rows
ORDER BY sentinel, severity, source_path, order_span, order_target, candidate_rank
"#;

struct IssueDraft {
    issue: ReferenceIssue,
    encrypted: bool,
    automatic_actionable: bool,
}

impl IssueDraft {
    fn finish(mut self) -> ReferenceIssue {
        self.issue.fingerprint =
            evidence_fingerprint(&self.issue.fingerprint, &self.issue.candidates);
        self.issue.actions = actions_for(
            self.issue.kind,
            self.encrypted,
            self.automatic_actionable,
            self.issue.candidates.len(),
        );
        self.issue
    }
}

pub(crate) fn project(
    connection: &Connection,
    filter: ReferenceIssueFilter,
) -> Result<ReferenceIssuePage, IndexError> {
    let includes = |kind| filter.kinds.contains(&kind);
    let all_kinds = filter.kinds.is_empty();
    let page_kind = filter.page_kind.map(Kind::as_str);
    let actionable = match filter.actionable {
        None => -1_i64,
        Some(false) => 0,
        Some(true) => 1,
    };
    let mut statement = connection.prepare(PROJECTION_SQL)?;
    let mut rows = statement.query(named_params! {
        ":all_kinds": all_kinds,
        ":unresolved_page_link": includes(ReferenceIssueKind::UnresolvedPageLink),
        ":ambiguous_page_link": includes(ReferenceIssueKind::AmbiguousPageLink),
        ":broken_block_ref": includes(ReferenceIssueKind::BrokenBlockRef),
        ":invalid_relation_target": includes(ReferenceIssueKind::InvalidRelationTarget),
        ":orphan_page": includes(ReferenceIssueKind::OrphanPage),
        ":isolated_page": includes(ReferenceIssueKind::IsolatedPage),
        ":project": filter.project,
        ":page_kind": page_kind,
        ":actionable": actionable,
        ":limit": i64::from(filter.limit),
        ":offset": i64::from(filter.offset),
    })?;

    let mut total = 0_u64;
    let mut items = Vec::new();
    let mut current: Option<IssueDraft> = None;

    while let Some(row) = rows.next()? {
        let row_total: i64 = row.get(0)?;
        total = u64::try_from(row_total)
            .map_err(|_| IndexError::Other(format!("negative reference issue total: {row_total}")))?;

        let Some(kind_raw) = row.get::<_, Option<String>>(1)? else {
            continue;
        };
        let kind = ReferenceIssueKind::from_str(&kind_raw)?;
        let source_id: String = row.get(2)?;
        let span_start: Option<i64> = row.get(6)?;
        let target_raw: Option<String> = row.get(10)?;
        let source_revision: String = row.get(5)?;
        let fingerprint = fingerprint(
            kind,
            &source_id,
            &source_revision,
            span_start,
            row.get(7)?,
            target_raw.as_deref(),
        );

        let starts_new_issue = current
            .as_ref()
            .is_none_or(|draft| draft.issue.fingerprint != fingerprint);
        if starts_new_issue {
            if let Some(draft) = current.take() {
                items.push(draft.finish());
            }
            let encrypted = row.get::<_, i64>(11)? != 0;
            let automatic_actionable = row.get::<_, i64>(12)? != 0;
            let span_end = row.get(7)?;
            let source_field: Option<String> = row.get(8)?;
            let body: Option<String> = row.get(9)?;
            let snippet = snippet(
                encrypted,
                kind,
                source_field.as_deref(),
                body.as_deref(),
                span_start,
                span_end,
            );
            let redact_body = is_encrypted_body_issue(encrypted, kind);
            let (public_span_start, public_span_end, public_source_field, public_target_raw) =
                if redact_body {
                    (None, None, None, None)
                } else {
                    (span_start, span_end, source_field, target_raw)
                };
            current = Some(IssueDraft {
                issue: ReferenceIssue {
                    fingerprint,
                    kind,
                    source_id,
                    source_path: row.get(3)?,
                    source_title: row.get(4)?,
                    source_revision,
                    span_start: public_span_start,
                    span_end: public_span_end,
                    source_field: public_source_field,
                    snippet,
                    target_raw: public_target_raw,
                    candidates: Vec::new(),
                    actions: Vec::new(),
                },
                encrypted,
                automatic_actionable,
            });
        }

        if let Some(page_id) = row.get::<_, Option<String>>(13)? {
            let draft = current.as_mut().ok_or_else(|| {
                IndexError::Other("candidate row had no reference issue".to_string())
            })?;
            if !is_encrypted_body_issue(draft.encrypted, draft.issue.kind) {
                draft.issue.candidates.push(ReferenceCandidate {
                    page_id,
                    path: row.get(14)?,
                    title: row.get(15)?,
                    rationale: row.get(16)?,
                });
            }
        }
    }

    if let Some(draft) = current {
        items.push(draft.finish());
    }

    Ok(ReferenceIssuePage { items, total })
}

fn fingerprint(
    kind: ReferenceIssueKind,
    source_id: &str,
    source_revision: &str,
    span_start: Option<i64>,
    span_end: Option<i64>,
    target_raw: Option<&str>,
) -> String {
    let identity = format!(
        "v1\0{}\0{}\0{}\0{}\0{}\0{}",
        kind.as_str(),
        source_id,
        source_revision,
        span_start.map_or_else(String::new, |value| value.to_string()),
        span_end.map_or_else(String::new, |value| value.to_string()),
        target_raw.unwrap_or_default(),
    );
    blake3::hash(identity.as_bytes()).to_hex().to_string()
}

fn evidence_fingerprint(base: &str, candidates: &[ReferenceCandidate]) -> String {
    let mut identity = String::from("v1-evidence\0");
    identity.push_str(base);
    for candidate in candidates {
        identity.push('\0');
        identity.push_str(&candidate.page_id);
        identity.push('\0');
        identity.push_str(&candidate.path);
        identity.push('\0');
        identity.push_str(candidate.title.as_deref().unwrap_or_default());
        identity.push('\0');
        identity.push_str(&candidate.rationale);
    }
    blake3::hash(identity.as_bytes()).to_hex().to_string()
}

fn snippet(
    encrypted: bool,
    kind: ReferenceIssueKind,
    source_field: Option<&str>,
    body: Option<&str>,
    span_start: Option<i64>,
    span_end: Option<i64>,
) -> Option<String> {
    if kind == ReferenceIssueKind::InvalidRelationTarget {
        return source_field.map(|field| format!("frontmatter field: {field}"));
    }
    if encrypted {
        return None;
    }
    let start = usize::try_from(span_start?).ok()?;
    let end = usize::try_from(span_end?).ok()?;
    if start == 0 || end < start {
        return None;
    }
    body?.get(start..end).map(ToOwned::to_owned)
}
fn is_encrypted_body_issue(encrypted: bool, kind: ReferenceIssueKind) -> bool {
    encrypted
        && matches!(
            kind,
            ReferenceIssueKind::UnresolvedPageLink
                | ReferenceIssueKind::AmbiguousPageLink
                | ReferenceIssueKind::BrokenBlockRef
        )
}


fn actions_for(
    kind: ReferenceIssueKind,
    encrypted: bool,
    automatic_actionable: bool,
    candidate_count: usize,
) -> Vec<ReferenceIssueAction> {
    if is_encrypted_body_issue(encrypted, kind) {
        return vec![ReferenceIssueAction::OpenSource];
    }
    match kind {
        ReferenceIssueKind::UnresolvedPageLink => {
            let mut actions = vec![ReferenceIssueAction::Create];
            if candidate_count > 0 {
                actions.push(ReferenceIssueAction::Replace);
            }
            actions.push(ReferenceIssueAction::OpenSource);
            actions
        }
        ReferenceIssueKind::AmbiguousPageLink => vec![
            ReferenceIssueAction::Replace,
            ReferenceIssueAction::OpenSource,
        ],
        ReferenceIssueKind::BrokenBlockRef if automatic_actionable => vec![
            ReferenceIssueAction::Replace,
            ReferenceIssueAction::OpenSource,
        ],
        ReferenceIssueKind::InvalidRelationTarget if automatic_actionable => vec![
            ReferenceIssueAction::Replace,
            ReferenceIssueAction::OpenSource,
        ],
        ReferenceIssueKind::BrokenBlockRef
        | ReferenceIssueKind::InvalidRelationTarget
        | ReferenceIssueKind::OrphanPage
        | ReferenceIssueKind::IsolatedPage => vec![ReferenceIssueAction::OpenSource],
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;
    use crate::vault::index::VaultIndex;
    use crate::vault::kind::Kind;

    fn insert_page(
        index: &VaultIndex,
        id: &str,
        path: &str,
        title: &str,
        revision: &str,
        kind: Kind,
        project: Option<&str>,
        encrypted: bool,
        body: &str,
    ) {
        index
            .connection()
            .execute(
                "INSERT INTO pages (
                    id, path, title, canonical_name, meta_json, content_hash,
                    kind, kind_inferred, project, encrypted
                 ) VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6, 0, ?7, ?8)",
                params![
                    id,
                    path,
                    title,
                    title.to_ascii_lowercase(),
                    revision,
                    kind.as_str(),
                    project,
                    encrypted,
                ],
            )
            .unwrap();
        index
            .connection()
            .execute(
                "INSERT INTO pages_fts (page_id, path, title, body)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, path, title, body],
            )
            .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_link(
        index: &VaultIndex,
        source_id: &str,
        target_raw: &str,
        target_canonical: Option<&str>,
        target_id: Option<&str>,
        target_path: Option<&str>,
        target_block_id: Option<&str>,
        kind: &str,
        source_field: Option<&str>,
        span_start: i64,
        span_end: i64,
    ) {
        index
            .connection()
            .execute(
                "INSERT INTO links (
                    source_id, target_raw, target_canonical, target_id,
                    target_path, target_block_id, kind, source_field,
                    span_start, span_end
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    source_id,
                    target_raw,
                    target_canonical,
                    target_id,
                    target_path,
                    target_block_id,
                    kind,
                    source_field,
                    span_start,
                    span_end,
                ],
            )
            .unwrap();
    }

    fn insert_canonical_name(index: &VaultIndex, page_id: &str, name: &str) {
        index
            .connection()
            .execute(
                "INSERT INTO canonical_names (canonical_name, page_id, source)
                 VALUES (?1, ?2, 'title')",
                params![name, page_id],
            )
            .unwrap();
    }
    fn insert_block(index: &VaultIndex, page_id: &str, block_id: &str, span_start: i64) {
        index
            .connection()
            .execute(
                "INSERT INTO blocks (
                    block_id, page_id, block_type, parent_id, order_index,
                    content, depth, span_start, span_end
                 ) VALUES (?1, ?2, 'paragraph', NULL, ?3, 'candidate', 0, ?3, ?4)",
                params![block_id, page_id, span_start, span_start + 9],
            )
            .unwrap();
    }


    fn connect_source_to_anchor(index: &VaultIndex, source_id: &str, source_span: i64) {
        insert_page(
            index,
            "anchor",
            "projects/anchor.md",
            "Anchor",
            "anchor-rev",
            Kind::Project,
            None,
            false,
            "anchor",
        );
        insert_link(
            index,
            source_id,
            "[[Anchor]]",
            Some("anchor"),
            Some("anchor"),
            Some("projects/anchor.md"),
            None,
            "wiki",
            None,
            source_span,
            source_span + 10,
        );
        insert_link(
            index,
            "anchor",
            "[[Source]]",
            Some("source"),
            Some(source_id),
            Some("notes/source.md"),
            None,
            "wiki",
            None,
            1,
            11,
        );
    }

    fn fixture_with_wiki_block_and_relation_misses() -> VaultIndex {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "source",
            "notes/source.md",
            "Source",
            "rev-1",
            Kind::Note,
            Some("alpha"),
            false,
            "prefix ((dead)) and [[missing]]",
        );
        connect_source_to_anchor(&index, "source", 100);
        insert_link(
            &index,
            "source",
            "((dead))",
            None,
            None,
            None,
            Some("dead"),
            "block_ref",
            None,
            7,
            15,
        );
        insert_link(
            &index,
            "source",
            "unknown-project",
            Some("unknown-project"),
            None,
            None,
            None,
            "property_ref",
            Some("related"),
            -1,
            -1,
        );
        insert_link(
            &index,
            "source",
            "[[missing]]",
            Some("missing"),
            None,
            None,
            None,
            "wiki",
            None,
            20,
            31,
        );
        index
    }

    #[test]
    fn classifies_unresolved_rows_by_indexed_link_kind_in_severity_order() {
        let index = fixture_with_wiki_block_and_relation_misses();
        let issues = index
            .reference_issues(ReferenceIssueFilter::default())
            .unwrap();

        assert_eq!(
            issues
                .items
                .iter()
                .map(|issue| issue.kind)
                .collect::<Vec<_>>(),
            vec![
                ReferenceIssueKind::BrokenBlockRef,
                ReferenceIssueKind::InvalidRelationTarget,
                ReferenceIssueKind::UnresolvedPageLink,
            ]
        );
    }

    #[test]
    fn classifies_ambiguous_wiki_links_and_ranks_canonical_candidates_by_path() {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "source",
            "notes/source.md",
            "Source",
            "rev-ambiguous",
            Kind::Note,
            None,
            false,
            "prefix [[Twin]] suffix",
        );
        insert_page(
            &index,
            "candidate-z",
            "projects/z-twin.md",
            "Z Twin",
            "rev-z",
            Kind::Project,
            None,
            false,
            "z",
        );
        insert_page(
            &index,
            "candidate-a",
            "notes/a-twin.md",
            "A Twin",
            "rev-a",
            Kind::Note,
            None,
            false,
            "a",
        );
        insert_canonical_name(&index, "candidate-z", "twin");
        insert_canonical_name(&index, "candidate-a", "twin");
        insert_link(
            &index,
            "source",
            "[[Twin]]",
            Some("twin"),
            None,
            None,
            None,
            "wiki",
            None,
            7,
            15,
        );

        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::AmbiguousPageLink],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();

        assert_eq!(page.total, 1);
        let issue = &page.items[0];
        assert_eq!(issue.kind, ReferenceIssueKind::AmbiguousPageLink);
        assert_eq!(issue.source_path, "notes/source.md");
        assert_eq!(issue.snippet.as_deref(), Some("[[Twin]]"));
        assert_eq!(
            issue
                .candidates
                .iter()
                .map(|candidate| (
                    candidate.page_id.as_str(),
                    candidate.path.as_str(),
                    candidate.title.as_deref(),
                    candidate.rationale.as_str(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "candidate-a",
                    "notes/a-twin.md",
                    Some("A Twin"),
                    "canonical_name",
                ),
                (
                    "candidate-z",
                    "projects/z-twin.md",
                    Some("Z Twin"),
                    "canonical_name",
                ),
            ]
        );
        assert_eq!(
            issue.actions,
            vec![
                ReferenceIssueAction::Replace,
                ReferenceIssueAction::OpenSource,
            ]
        );
    }

    #[test]
    fn distinguishes_orphan_from_isolated_pages_using_resolved_edges() {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "outbound-only",
            "notes/outbound-only.md",
            "Outbound Only",
            "rev-out",
            Kind::Note,
            None,
            false,
            "[[Inbound Only]]",
        );
        insert_page(
            &index,
            "inbound-only",
            "notes/inbound-only.md",
            "Inbound Only",
            "rev-in",
            Kind::Note,
            None,
            false,
            "inbound",
        );
        insert_page(
            &index,
            "neither",
            "notes/neither.md",
            "Neither",
            "rev-neither",
            Kind::Note,
            None,
            false,
            "neither",
        );
        insert_link(
            &index,
            "outbound-only",
            "[[Inbound Only]]",
            Some("inbound only"),
            Some("inbound-only"),
            Some("notes/inbound-only.md"),
            None,
            "wiki",
            None,
            0,
            16,
        );

        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![
                    ReferenceIssueKind::OrphanPage,
                    ReferenceIssueKind::IsolatedPage,
                ],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();

        assert_eq!(page.total, 2);
        assert_eq!(
            page.items
                .iter()
                .map(|issue| (issue.source_path.as_str(), issue.kind))
                .collect::<Vec<_>>(),
            vec![
                ("notes/outbound-only.md", ReferenceIssueKind::OrphanPage),
                ("notes/neither.md", ReferenceIssueKind::IsolatedPage),
            ]
        );
        assert!(page.items.iter().all(|issue| {
            issue.actions == vec![ReferenceIssueAction::OpenSource]
                && issue.span_start.is_none()
                && issue.target_raw.is_none()
        }));
    }

    #[test]
    fn fingerprints_the_versioned_issue_identity_and_preserves_source_evidence() {
        let index = fixture_with_wiki_block_and_relation_misses();
        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::BrokenBlockRef],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();
        let issue = &page.items[0];
        let base = blake3::hash(
            b"v1\0broken_block_ref\0source\0rev-1\07\015\0((dead))",
        )
        .to_hex()
        .to_string();
        let expected = evidence_fingerprint(&base, &[]);

        assert_eq!(issue.fingerprint, expected);
        assert_eq!(issue.source_id, "source");
        assert_eq!(issue.source_path, "notes/source.md");
        assert_eq!(issue.source_title.as_deref(), Some("Source"));
        assert_eq!(issue.source_revision, "rev-1");
        assert_eq!(issue.span_start, Some(7));
        assert_eq!(issue.span_end, Some(15));
        assert_eq!(issue.snippet.as_deref(), Some("((dead))"));
        assert_eq!(issue.target_raw.as_deref(), Some("((dead))"));
    }

    #[test]
    fn relation_issues_use_frontmatter_field_evidence_not_body_text() {
        let index = fixture_with_wiki_block_and_relation_misses();
        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::InvalidRelationTarget],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();
        let issue = &page.items[0];

        assert_eq!(issue.source_field.as_deref(), Some("related"));
        assert_eq!(issue.snippet.as_deref(), Some("frontmatter field: related"));
        assert_eq!(issue.span_start, Some(-1));
        assert_eq!(issue.span_end, Some(-1));
    }

    #[test]
    fn encrypted_body_issues_redact_all_public_body_evidence() {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "encrypted",
            "notes/encrypted.md",
            "Encrypted",
            "secret-rev",
            Kind::Note,
            None,
            true,
            "prefix [[secret]] ((dead-secret))",
        );
        insert_page(
            &index,
            "candidate",
            "notes/candidate.md",
            "Candidate",
            "candidate-rev",
            Kind::Note,
            None,
            false,
            "candidate",
        );
        insert_canonical_name(&index, "candidate", "secret");
        insert_block(&index, "candidate", "dead-secret", 1);
        insert_link(
            &index,
            "encrypted",
            "[[secret]]",
            Some("secret"),
            None,
            None,
            None,
            "wiki",
            Some("must-not-leak"),
            7,
            17,
        );
        insert_link(
            &index,
            "encrypted",
            "((dead-secret))",
            None,
            None,
            None,
            Some("dead-secret"),
            "block_ref",
            Some("must-not-leak"),
            18,
            33,
        );

        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![
                    ReferenceIssueKind::UnresolvedPageLink,
                    ReferenceIssueKind::BrokenBlockRef,
                ],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();

        assert_eq!(page.total, 2);
        for issue in &page.items {
            assert_eq!(issue.span_start, None);
            assert_eq!(issue.span_end, None);
            assert_eq!(issue.source_field, None);
            assert_eq!(issue.snippet, None);
            assert_eq!(issue.target_raw, None);
            assert!(issue.candidates.is_empty());
            assert_eq!(issue.actions, vec![ReferenceIssueAction::OpenSource]);
        }
        let wiki = page
            .items
            .iter()
            .find(|issue| issue.kind == ReferenceIssueKind::UnresolvedPageLink)
            .unwrap();
        let base = blake3::hash(
            b"v1\0unresolved_page_link\0encrypted\0secret-rev\07\017\0[[secret]]",
        )
        .to_hex()
        .to_string();
        assert_eq!(wiki.fingerprint, evidence_fingerprint(&base, &[]));
    }

    #[test]
    fn encrypted_property_relations_remain_clear_metadata() {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "encrypted",
            "notes/encrypted.md",
            "Encrypted",
            "secret-rev",
            Kind::Note,
            None,
            true,
            "ciphertext",
        );
        insert_page(
            &index,
            "candidate",
            "projects/known.md",
            "Known",
            "candidate-rev",
            Kind::Project,
            None,
            false,
            "known",
        );
        insert_canonical_name(&index, "candidate", "known");
        insert_link(
            &index,
            "encrypted",
            "known",
            Some("known"),
            None,
            None,
            None,
            "property_ref",
            Some("related"),
            -1,
            -1,
        );

        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::InvalidRelationTarget],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();
        let issue = &page.items[0];

        assert_eq!(issue.span_start, Some(-1));
        assert_eq!(issue.span_end, Some(-1));
        assert_eq!(issue.source_field.as_deref(), Some("related"));
        assert_eq!(issue.snippet.as_deref(), Some("frontmatter field: related"));
        assert_eq!(issue.target_raw.as_deref(), Some("known"));
        assert_eq!(issue.candidates.len(), 1);
        assert_eq!(
            issue.actions,
            vec![
                ReferenceIssueAction::Replace,
                ReferenceIssueAction::OpenSource,
            ]
        );
    }

    #[test]
    fn encrypted_page_without_indexed_outlinks_is_orphan_not_isolated() {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "encrypted",
            "notes/encrypted.md",
            "Encrypted",
            "secret-rev",
            Kind::Note,
            None,
            true,
            "ciphertext",
        );
        insert_page(
            &index,
            "plaintext",
            "notes/plaintext.md",
            "Plaintext",
            "plain-rev",
            Kind::Note,
            None,
            false,
            "plaintext",
        );

        let page = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![
                    ReferenceIssueKind::OrphanPage,
                    ReferenceIssueKind::IsolatedPage,
                ],
                ..ReferenceIssueFilter::default()
            })
            .unwrap();

        assert_eq!(
            page.items
                .iter()
                .map(|issue| (issue.source_id.as_str(), issue.kind))
                .collect::<Vec<_>>(),
            vec![
                ("encrypted", ReferenceIssueKind::OrphanPage),
                ("plaintext", ReferenceIssueKind::IsolatedPage),
            ]
        );
    }

    #[test]
    fn duplicate_block_rows_on_one_page_are_not_actionable() {
        let index = VaultIndex::open_in_memory().unwrap();
        insert_page(
            &index,
            "source",
            "notes/source.md",
            "Source",
            "source-rev",
            Kind::Note,
            None,
            false,
            "prefix ((duplicate))",
        );
        insert_page(
            &index,
            "candidate",
            "notes/candidate.md",
            "Candidate",
            "candidate-rev",
            Kind::Note,
            None,
            false,
            "duplicate blocks",
        );
        insert_block(&index, "candidate", "duplicate", 1);
        insert_block(&index, "candidate", "duplicate", 20);
        insert_link(
            &index,
            "source",
            "((duplicate))",
            None,
            None,
            None,
            Some("duplicate"),
            "block_ref",
            None,
            7,
            20,
        );

        let non_actionable = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::BrokenBlockRef],
                actionable: Some(false),
                ..ReferenceIssueFilter::default()
            })
            .unwrap();
        let actionable = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::BrokenBlockRef],
                actionable: Some(true),
                ..ReferenceIssueFilter::default()
            })
            .unwrap();

        assert_eq!(non_actionable.total, 1);
        assert_eq!(non_actionable.items[0].candidates.len(), 1);
        assert_eq!(
            non_actionable.items[0].actions,
            vec![ReferenceIssueAction::OpenSource]
        );
        assert_eq!(actionable.total, 0);
        assert!(actionable.items.is_empty());
    }

    #[test]
    fn filters_before_pagination_and_computes_total_from_the_filtered_relation() {
        let index = fixture_with_wiki_block_and_relation_misses();
        insert_link(
            &index,
            "source",
            "((also-dead))",
            None,
            None,
            None,
            Some("also-dead"),
            "block_ref",
            None,
            32,
            45,
        );

        let first = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::BrokenBlockRef],
                project: Some("alpha".to_string()),
                page_kind: Some(Kind::Note),
                actionable: Some(false),
                limit: 1,
                offset: 0,
            })
            .unwrap();
        let past_end = index
            .reference_issues(ReferenceIssueFilter {
                kinds: vec![ReferenceIssueKind::BrokenBlockRef],
                project: Some("alpha".to_string()),
                page_kind: Some(Kind::Note),
                actionable: Some(false),
                limit: 1,
                offset: 3,
            })
            .unwrap();

        assert_eq!(first.total, 2);
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].target_raw.as_deref(), Some("((dead))"));
        assert_eq!(past_end.total, 2);
        assert!(past_end.items.is_empty());
    }

    #[test]
    fn actionable_filter_selects_only_automatic_create_or_replace_actions() {
        let index = fixture_with_wiki_block_and_relation_misses();
        let page = index
            .reference_issues(ReferenceIssueFilter {
                actionable: Some(true),
                ..ReferenceIssueFilter::default()
            })
            .unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].kind, ReferenceIssueKind::UnresolvedPageLink);
        assert_eq!(
            page.items[0].actions,
            vec![
                ReferenceIssueAction::Create,
                ReferenceIssueAction::OpenSource,
            ]
        );
    }
}
