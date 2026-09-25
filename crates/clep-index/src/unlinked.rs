//! Unlinked mentions: pages whose body names a page (its title or an alias)
//! without linking to it. FTS5 narrows the candidates; an exact,
//! case-insensitive, whole-phrase scan of each body confirms them, because
//! the porter tokenizer also matches stems ("alphas" for "alpha").

use std::collections::HashSet;

use rusqlite::{OptionalExtension, params};

use crate::grep::fts_quote;
use crate::index::{IndexError, VaultIndex};
use clep_vault::canonical::CanonicalName;
use clep_vault::path::VaultPath;

/// Terms shorter than this many characters are too common to search for.
const MIN_TERM_CHARS: usize = 3;
/// Upper bound on FTS candidates per term, before exact verification.
const CANDIDATES_PER_TERM: u32 = 500;
/// Characters of context kept on each side of the mention.
const CONTEXT_RADIUS: usize = 75;

/// One page that mentions the target without linking to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnlinkedMention {
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    /// The title or alias as written in the source body.
    pub matched: String,
    /// Plain-text window around the first mention, with "…" at cut ends.
    pub context: String,
}

impl VaultIndex {
    /// Pages whose body mentions `target`'s title (or file stem when it has
    /// none) or one of its aliases as a whole phrase, ignoring case, and that
    /// do not link to `target`. The target itself and encrypted pages are
    /// never sources. Sorted by source title, then path; at most `limit`.
    pub fn unlinked_mentions(
        &self,
        target: &VaultPath,
        limit: usize,
    ) -> Result<Vec<UnlinkedMention>, IndexError> {
        self.unlinked_mentions_with_candidate_cap(target, limit, CANDIDATES_PER_TERM)
    }

    /// [`Self::unlinked_mentions`] with an explicit per-term FTS candidate
    /// cap, so tests can prove exclusions happen before the cap.
    #[doc(hidden)]
    pub fn unlinked_mentions_with_candidate_cap(
        &self,
        target: &VaultPath,
        limit: usize,
        candidates_per_term: u32,
    ) -> Result<Vec<UnlinkedMention>, IndexError> {
        let conn = self.connection();
        let row: Option<(String, Option<String>, String, bool)> = conn
            .query_row(
                "SELECT id, title, meta_json, encrypted FROM pages WHERE path = ?1",
                params![target.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((target_id, title, meta_json, encrypted)) = row else {
            return Ok(Vec::new());
        };
        if encrypted {
            return Ok(Vec::new());
        }

        let aliases = meta_aliases(&meta_json);
        let terms = search_terms(title.as_deref().unwrap_or(target.stem()), &aliases);
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        // Self, linking pages and encrypted pages are excluded inside the
        // query, before the cap: a hub page's many linkers must not crowd out
        // its unlinked mentions.
        let canonical = CanonicalName::from_filename(target.stem());
        let mut candidates: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut fts = conn.prepare(
            "SELECT f.page_id FROM pages_fts f
             JOIN pages p ON p.id = f.page_id
             WHERE pages_fts MATCH ?1
               AND p.encrypted = 0
               AND f.page_id != ?2
               AND f.page_id NOT IN (
                   SELECT source_id FROM links
                   WHERE target_id = ?2 OR target_path = ?3 OR target_canonical = ?4
               )
             LIMIT ?5",
        )?;
        for term in &terms {
            let query = format!("body : {}", fts_quote(term));
            let ids = fts
                .query_map(
                    params![
                        query,
                        target_id,
                        target.as_str(),
                        canonical.as_str(),
                        candidates_per_term
                    ],
                    |r| r.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for id in ids {
                if seen.insert(id.clone()) {
                    candidates.push(id);
                }
            }
        }
        drop(fts);

        let mut source = conn.prepare(
            "SELECT p.path, p.title, b.body FROM pages p
             JOIN page_bodies b ON b.page_id = p.id
             WHERE p.id = ?1 AND p.encrypted = 0",
        )?;
        let mut found = Vec::new();
        for id in candidates {
            let row: Option<(String, Option<String>, String)> = source
                .query_row(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            let Some((path, source_title, body)) = row else {
                continue;
            };
            if let Some((start, end)) = first_mention(&body, &terms) {
                found.push(UnlinkedMention {
                    source_id: id,
                    source_path: path,
                    source_title,
                    matched: body[start..end].to_string(),
                    context: context_window(&body, start, end),
                });
            }
        }

        found.sort_by(|a, b| {
            let key = |m: &UnlinkedMention| {
                m.source_title
                    .as_deref()
                    .unwrap_or(&m.source_path)
                    .to_lowercase()
            };
            key(a)
                .cmp(&key(b))
                .then_with(|| a.source_path.cmp(&b.source_path))
        });
        found.truncate(limit);
        Ok(found)
    }
}

/// The `aliases` list from a page's stored `meta_json`.
fn meta_aliases(meta_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(meta_json)
        .ok()
        .and_then(|meta| meta.get("aliases").cloned())
        .and_then(|aliases| serde_json::from_value(aliases).ok())
        .unwrap_or_default()
}

/// The title and aliases, trimmed, deduplicated ignoring case, and at least
/// [`MIN_TERM_CHARS`] characters long.
fn search_terms(title: &str, aliases: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    std::iter::once(title)
        .chain(aliases.iter().map(String::as_str))
        .map(str::trim)
        .filter(|t| t.chars().count() >= MIN_TERM_CHARS)
        .filter(|t| seen.insert(t.to_lowercase()))
        .map(str::to_string)
        .collect()
}

/// Byte range of the earliest whole-phrase, case-insensitive occurrence of any
/// term that does not sit inside a `[[wikilink]]`.
fn first_mention(body: &str, terms: &[String]) -> Option<(usize, usize)> {
    let links = wikilink_spans(body);
    let inside_link = |at: usize| links.iter().any(|&(s, e)| at >= s && at < e);
    let mut prev: Option<char> = None;
    for (start, ch) in body.char_indices() {
        let boundary_before = prev.is_none_or(|c| !c.is_alphanumeric());
        prev = Some(ch);
        if !boundary_before || inside_link(start) {
            continue;
        }
        for term in terms {
            if let Some(end) = match_at(body, start, term)
                && body[end..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_alphanumeric())
            {
                return Some((start, end));
            }
        }
    }
    None
}

/// If `body[start..]` begins with `term` (ignoring case), the end offset.
/// A whitespace run in the term matches any whitespace run in the body, so
/// hard-wrapped or double-spaced text still matches a multi-word title.
fn match_at(body: &str, start: usize, term: &str) -> Option<usize> {
    let mut rest = body[start..].char_indices().peekable();
    let mut wanted = term.chars().peekable();
    let mut end = start;
    while let Some(t) = wanted.next() {
        let (offset, b) = rest.next()?;
        if t.is_whitespace() {
            if !b.is_whitespace() {
                return None;
            }
            while wanted.next_if(|c| c.is_whitespace()).is_some() {}
            end = start + offset + b.len_utf8();
            while let Some((o, c)) = rest.next_if(|(_, c)| c.is_whitespace()) {
                end = start + o + c.len_utf8();
            }
            continue;
        }
        if !b.to_lowercase().eq(t.to_lowercase()) {
            return None;
        }
        end = start + offset + b.len_utf8();
    }
    Some(end)
}

/// Byte ranges covered by `[[ … ]]` wikilinks (including embeds).
fn wikilink_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(open) = body[from..].find("[[") {
        let s = from + open;
        match body[s + 2..].find("]]") {
            Some(close) => {
                let e = s + 2 + close + 2;
                spans.push((s, e));
                from = e;
            }
            None => break,
        }
    }
    spans
}

/// Up to [`CONTEXT_RADIUS`] characters either side of the mention, cut on
/// character boundaries, whitespace collapsed, "…" where text was cut.
fn context_window(body: &str, start: usize, end: usize) -> String {
    let before: Vec<(usize, char)> = body[..start].char_indices().collect();
    let from = before
        .len()
        .checked_sub(CONTEXT_RADIUS)
        .map_or(0, |i| before[i].0);
    let to = body[end..]
        .char_indices()
        .nth(CONTEXT_RADIUS)
        .map_or(body.len(), |(i, _)| end + i);
    let text = body[from..to]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{}{}{}",
        if from > 0 { "…" } else { "" },
        text,
        if to < body.len() { "…" } else { "" },
    )
}
