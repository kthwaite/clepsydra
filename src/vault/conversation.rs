use std::collections::HashMap;
use std::fmt::Write;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::page::PageMeta;

pub const CONVERSATION_META_KEY: &str = "conversation";

const HOST_HASH_DOMAIN: &[u8] = b"clepsydra-conversation-host-v1";
const TURN_HASH_DOMAIN: &[u8] = b"clepsydra-conversation-turn-v1";
const PREFIX_HASH_DOMAIN: &[u8] = b"clepsydra-conversation-prefix-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationTurn {
    pub role: ConversationRole,
    pub content: String,
    pub source_turn_id: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTurn {
    pub role: ConversationRole,
    pub content: String,
    pub source_identity: String,
    pub source_sequence: u64,
    pub timestamp: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationLedger {
    pub provider: Option<String>,
    pub host_id_hash: Option<String>,
    pub captured_turn_count: u64,
    pub captured_prefix_hash: String,
    pub last_source_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTranscript {
    pub turns: Vec<PreparedTurn>,
    pub prefix_hashes: Vec<String>,
    pub ledger: ConversationLedger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendDecision {
    Unchanged,
    AppendFrom(usize),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConversationError {
    #[error("provider must contain 1-64 characters from [a-z0-9._-]")]
    InvalidProvider,
    #[error("host ID must not be blank")]
    BlankHostId,
    #[error("host ID hash must be a sha256: prefix followed by 64 lowercase hex characters")]
    InvalidHostIdHash,
    #[error("turn {sequence} content must not be blank")]
    BlankTurnContent { sequence: u64 },
    #[error("source turn ID at sequence {duplicate_sequence} repeats sequence {first_sequence}")]
    DuplicateSourceTurnId {
        first_sequence: u64,
        duplicate_sequence: u64,
    },
    #[error("turn count exceeds the supported range")]
    TurnCountOverflow,
    #[error("invalid conversation ledger: {0}")]
    InvalidLedger(String),
    #[error("invalid prepared transcript: {0}")]
    InvalidTranscript(String),
    #[error("submitted transcript provider differs from the stored conversation")]
    ProviderConflict,
    #[error("submitted transcript host identity differs from the stored conversation")]
    HostIdentityConflict,
    #[error(
        "submitted transcript has {submitted} turns but the stored conversation has {existing}"
    )]
    TruncatedTranscript { existing: u64, submitted: u64 },
    #[error("submitted transcript diverges from the stored conversation at sequence {sequence}")]
    DivergentTranscript { sequence: u64 },
}

pub fn normalize_provider(raw: Option<&str>) -> Result<Option<String>, ConversationError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 64
        || !normalized.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
    {
        return Err(ConversationError::InvalidProvider);
    }
    Ok(Some(normalized))
}

pub fn host_identity_hash(provider: &str, host_id: &str) -> Result<String, ConversationError> {
    let provider = normalize_provider(Some(provider))?
        .expect("normalizing a supplied provider always returns Some");
    if host_id.trim().is_empty() {
        return Err(ConversationError::BlankHostId);
    }

    let mut digest = Sha256::new();
    digest.update(HOST_HASH_DOMAIN);
    hash_component(&mut digest, provider.as_bytes());
    hash_component(&mut digest, host_id.as_bytes());
    Ok(hash_string(digest))
}

pub fn prepare_transcript(
    provider: Option<&str>,
    host_id_hash: Option<String>,
    turns: &[ConversationTurn],
) -> Result<PreparedTranscript, ConversationError> {
    let provider = normalize_provider(provider)?;
    if let Some(hash) = &host_id_hash {
        validate_sha256(hash).map_err(|_| ConversationError::InvalidHostIdHash)?;
    }

    let captured_turn_count =
        u64::try_from(turns.len()).map_err(|_| ConversationError::TurnCountOverflow)?;
    let mut seen_source_ids = HashMap::with_capacity(turns.len());
    let mut prepared_turns = Vec::with_capacity(turns.len());

    for (index, turn) in turns.iter().enumerate() {
        let source_sequence = u64::try_from(index)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or(ConversationError::TurnCountOverflow)?;
        if turn.content.trim().is_empty() {
            return Err(ConversationError::BlankTurnContent {
                sequence: source_sequence,
            });
        }

        let source_turn_id = turn
            .source_turn_id
            .as_deref()
            .filter(|source_turn_id| !source_turn_id.trim().is_empty());
        if let Some(source_turn_id) = source_turn_id
            && let Some(first_sequence) = seen_source_ids.insert(source_turn_id, source_sequence)
        {
            return Err(ConversationError::DuplicateSourceTurnId {
                first_sequence,
                duplicate_sequence: source_sequence,
            });
        }

        prepared_turns.push(PreparedTurn {
            role: turn.role,
            content: turn.content.clone(),
            source_identity: turn_identity(
                turn.role,
                provider.as_deref().unwrap_or(""),
                source_turn_id,
                &turn.content,
            ),
            source_sequence,
            timestamp: turn.timestamp,
        });
    }

    let mut prefix_digest = Sha256::new();
    prefix_digest.update(PREFIX_HASH_DOMAIN);
    let mut prefix_hashes = Vec::with_capacity(prepared_turns.len());
    for turn in &prepared_turns {
        hash_component(&mut prefix_digest, &turn.source_sequence.to_be_bytes());
        hash_component(&mut prefix_digest, turn.source_identity.as_bytes());
        hash_component(&mut prefix_digest, role_token(turn.role));
        hash_component(&mut prefix_digest, turn.content.as_bytes());
        prefix_hashes.push(hash_string(prefix_digest.clone()));
    }

    let captured_prefix_hash = prefix_hashes
        .last()
        .cloned()
        .unwrap_or_else(empty_prefix_hash);
    let last_source_identity = prepared_turns
        .last()
        .map(|turn| turn.source_identity.clone())
        .unwrap_or_default();

    Ok(PreparedTranscript {
        turns: prepared_turns,
        prefix_hashes,
        ledger: ConversationLedger {
            provider,
            host_id_hash,
            captured_turn_count,
            captured_prefix_hash,
            last_source_identity,
        },
    })
}

pub fn verify_append(
    existing: &ConversationLedger,
    submitted: &PreparedTranscript,
) -> Result<AppendDecision, ConversationError> {
    validate_ledger(existing)?;
    validate_prepared_transcript(submitted)?;

    if existing.provider != submitted.ledger.provider {
        return Err(ConversationError::ProviderConflict);
    }
    if existing.host_id_hash != submitted.ledger.host_id_hash {
        return Err(ConversationError::HostIdentityConflict);
    }

    let submitted_count = submitted.ledger.captured_turn_count;
    if submitted_count < existing.captured_turn_count {
        return Err(ConversationError::TruncatedTranscript {
            existing: existing.captured_turn_count,
            submitted: submitted_count,
        });
    }

    let existing_count = usize::try_from(existing.captured_turn_count).map_err(|_| {
        ConversationError::InvalidLedger("turn count exceeds platform limits".into())
    })?;
    if existing_count > 0
        && submitted.prefix_hashes[existing_count - 1] != existing.captured_prefix_hash
    {
        return Err(ConversationError::DivergentTranscript {
            sequence: existing.captured_turn_count,
        });
    }

    if submitted_count == existing.captured_turn_count {
        if submitted.ledger.captured_prefix_hash == existing.captured_prefix_hash {
            Ok(AppendDecision::Unchanged)
        } else {
            Err(ConversationError::DivergentTranscript {
                sequence: existing.captured_turn_count,
            })
        }
    } else {
        Ok(AppendDecision::AppendFrom(existing_count))
    }
}

pub fn render_turns(turns: &[PreparedTurn]) -> String {
    let capacity = turns.iter().fold(0usize, |capacity, turn| {
        capacity
            .saturating_add(turn.content.len())
            .saturating_add(turn.source_identity.len())
            .saturating_add(96)
    });
    let mut rendered = String::with_capacity(capacity);

    for (index, turn) in turns.iter().enumerate() {
        if index > 0 {
            rendered.push('\n');
        }
        write!(
            &mut rendered,
            "> [!AI-{} source={} sequence={}",
            role_marker(turn.role),
            turn.source_identity,
            turn.source_sequence
        )
        .expect("writing to a String cannot fail");
        if let Some(timestamp) = turn.timestamp {
            write!(
                &mut rendered,
                " timestamp={}",
                timestamp.to_rfc3339_opts(SecondsFormat::AutoSi, true)
            )
            .expect("writing to a String cannot fail");
        }
        rendered.push_str("]\n");

        for line in turn.content.split('\n') {
            rendered.push('>');
            if !line.is_empty() {
                rendered.push(' ');
                rendered.push_str(line);
            }
            rendered.push('\n');
        }
    }

    rendered
}

pub fn append_rendered_turns(body: &str, turns: &[PreparedTurn]) -> String {
    if turns.is_empty() {
        return body.to_string();
    }
    let rendered = render_turns(turns);
    let body = body.trim_end_matches(['\r', '\n']);
    if body.is_empty() {
        return rendered;
    }

    let mut appended = String::with_capacity(body.len() + rendered.len() + 2);
    appended.push_str(body);
    appended.push_str("\n\n");
    appended.push_str(&rendered);
    appended
}

pub fn read_ledger(meta: &PageMeta) -> Result<Option<ConversationLedger>, ConversationError> {
    let Some(value) = meta.extra.get(CONVERSATION_META_KEY) else {
        return Ok(None);
    };
    let ledger: ConversationLedger = value
        .clone()
        .try_into()
        .map_err(|error| ConversationError::InvalidLedger(error.to_string()))?;
    validate_ledger(&ledger)?;
    Ok(Some(ledger))
}

pub fn write_ledger(
    meta: &mut PageMeta,
    ledger: &ConversationLedger,
) -> Result<(), ConversationError> {
    validate_ledger(ledger)?;
    let value = toml::Value::try_from(ledger)
        .map_err(|error| ConversationError::InvalidLedger(error.to_string()))?;
    if !matches!(value, toml::Value::Table(_)) {
        return Err(ConversationError::InvalidLedger(
            "conversation metadata must serialize as a table".into(),
        ));
    }
    meta.extra.insert(CONVERSATION_META_KEY.to_string(), value);
    Ok(())
}

fn turn_identity(
    role: ConversationRole,
    provider: &str,
    source_turn_id: Option<&str>,
    content: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(TURN_HASH_DOMAIN);
    hash_component(&mut digest, role_token(role));
    if let Some(source_turn_id) = source_turn_id {
        hash_component(&mut digest, provider.as_bytes());
        hash_component(&mut digest, source_turn_id.as_bytes());
    } else {
        hash_component(&mut digest, content.as_bytes());
    }
    hash_string(digest)
}

fn validate_prepared_transcript(transcript: &PreparedTranscript) -> Result<(), ConversationError> {
    let turn_count = usize::try_from(transcript.ledger.captured_turn_count).map_err(|_| {
        ConversationError::InvalidTranscript("turn count exceeds platform limits".into())
    })?;
    if transcript.turns.len() != turn_count || transcript.prefix_hashes.len() != turn_count {
        return Err(ConversationError::InvalidTranscript(
            "turn, prefix, and ledger counts differ".into(),
        ));
    }

    for (index, (turn, prefix_hash)) in transcript
        .turns
        .iter()
        .zip(&transcript.prefix_hashes)
        .enumerate()
    {
        let expected_sequence = u64::try_from(index)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or(ConversationError::TurnCountOverflow)?;
        if turn.source_sequence != expected_sequence {
            return Err(ConversationError::InvalidTranscript(
                "turn sequences must be contiguous and one-based".into(),
            ));
        }
        validate_sha256(&turn.source_identity).map_err(ConversationError::InvalidTranscript)?;
        validate_sha256(prefix_hash).map_err(ConversationError::InvalidTranscript)?;
    }

    let expected_prefix_hash = transcript
        .prefix_hashes
        .last()
        .cloned()
        .unwrap_or_else(empty_prefix_hash);
    let expected_last_identity = transcript
        .turns
        .last()
        .map(|turn| turn.source_identity.as_str())
        .unwrap_or("");
    if transcript.ledger.captured_prefix_hash != expected_prefix_hash
        || transcript.ledger.last_source_identity != expected_last_identity
    {
        return Err(ConversationError::InvalidTranscript(
            "ledger does not describe the prepared turns".into(),
        ));
    }
    validate_ledger(&transcript.ledger)
        .map_err(|error| ConversationError::InvalidTranscript(error.to_string()))
}

fn validate_ledger(ledger: &ConversationLedger) -> Result<(), ConversationError> {
    if let Some(provider) = &ledger.provider
        && normalize_provider(Some(provider))?.as_deref() != Some(provider)
    {
        return Err(ConversationError::InvalidLedger(
            "provider is not normalized".into(),
        ));
    }
    if let Some(hash) = &ledger.host_id_hash {
        validate_sha256(hash).map_err(|_| ConversationError::InvalidHostIdHash)?;
    }
    validate_sha256(&ledger.captured_prefix_hash).map_err(ConversationError::InvalidLedger)?;
    if ledger.captured_turn_count == 0 {
        if !ledger.last_source_identity.is_empty() {
            return Err(ConversationError::InvalidLedger(
                "an empty ledger cannot have a last source identity".into(),
            ));
        }
    } else {
        validate_sha256(&ledger.last_source_identity).map_err(ConversationError::InvalidLedger)?;
    }
    Ok(())
}

fn empty_prefix_hash() -> String {
    let mut digest = Sha256::new();
    digest.update(PREFIX_HASH_DOMAIN);
    hash_string(digest)
}

fn role_token(role: ConversationRole) -> &'static [u8] {
    match role {
        ConversationRole::User => b"user",
        ConversationRole::Assistant => b"assistant",
    }
}

fn role_marker(role: ConversationRole) -> &'static str {
    match role {
        ConversationRole::User => "USER",
        ConversationRole::Assistant => "ASSISTANT",
    }
}

fn hash_component(digest: &mut Sha256, component: &[u8]) {
    digest.update((component.len() as u64).to_be_bytes());
    digest.update(component);
}

fn hash_string(digest: Sha256) -> String {
    let bytes = digest.finalize();
    let mut hash = String::with_capacity(7 + bytes.len() * 2);
    hash.push_str("sha256:");
    for byte in bytes {
        write!(&mut hash, "{byte:02x}").expect("writing to a String cannot fail");
    }
    hash
}

fn validate_sha256(hash: &str) -> Result<(), String> {
    let Some(hex) = hash.strip_prefix("sha256:") else {
        return Err("hash must start with sha256:".into());
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("hash must contain exactly 64 lowercase hex characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    fn turn(role: ConversationRole, content: &str) -> ConversationTurn {
        ConversationTurn {
            role,
            content: content.to_string(),
            source_turn_id: None,
            timestamp: None,
        }
    }

    fn sourced_turn(
        role: ConversationRole,
        content: &str,
        source_turn_id: &str,
    ) -> ConversationTurn {
        ConversationTurn {
            role,
            content: content.to_string(),
            source_turn_id: Some(source_turn_id.to_string()),
            timestamp: None,
        }
    }

    #[test]
    fn provider_normalization_is_lowercase_trimmed_and_restricted() {
        assert_eq!(normalize_provider(None).unwrap(), None);
        assert_eq!(
            normalize_provider(Some(" Claude-3.5_Opus ")).unwrap(),
            Some("claude-3.5_opus".to_string())
        );

        for invalid in ["", "   ", "open ai", "café", "provider/name"] {
            assert!(matches!(
                normalize_provider(Some(invalid)),
                Err(ConversationError::InvalidProvider)
            ));
        }
        let too_long = "a".repeat(65);
        assert!(matches!(
            normalize_provider(Some(&too_long)),
            Err(ConversationError::InvalidProvider)
        ));
    }

    #[test]
    fn host_identity_is_versioned_stable_and_never_contains_the_raw_id() {
        let hash = host_identity_hash("Claude", "raw-host-id").unwrap();
        assert_eq!(
            hash,
            "sha256:34eeb6ae828d3ce1f07803d14957c1d469567c8a0a8b17d2082b0ba55ee6fad2"
        );
        assert!(!hash.contains("raw-host-id"));
        assert!(matches!(
            host_identity_hash("claude", "  "),
            Err(ConversationError::BlankHostId)
        ));
    }

    #[test]
    fn transcript_rejects_blank_content_and_unhashed_host_ids() {
        assert!(matches!(
            prepare_transcript(None, None, &[turn(ConversationRole::User, " \n\t")]),
            Err(ConversationError::BlankTurnContent { sequence: 1 })
        ));
        assert!(matches!(
            prepare_transcript(
                Some("claude"),
                Some("raw-host-id".to_string()),
                &[turn(ConversationRole::User, "Hello")],
            ),
            Err(ConversationError::InvalidHostIdHash)
        ));
    }

    #[test]
    fn source_turn_id_produces_a_stable_versioned_identity() {
        let first = prepare_transcript(
            Some("Claude"),
            None,
            &[sourced_turn(ConversationRole::User, "before", "turn-1")],
        )
        .unwrap();
        let edited = prepare_transcript(
            Some("claude"),
            None,
            &[
                turn(ConversationRole::Assistant, "earlier"),
                sourced_turn(ConversationRole::User, "after", "turn-1"),
            ],
        )
        .unwrap();

        assert_eq!(
            first.turns[0].source_identity,
            edited.turns[1].source_identity
        );
        assert_eq!(
            first.turns[0].source_identity,
            "sha256:4656419a9b9f271090588efaeedaf3504cac8f382d709f7a8efda2118566a841"
        );
    }

    #[test]
    fn repeated_nonempty_source_turn_id_is_rejected_without_exposing_the_raw_id() {
        const SENTINEL_SOURCE_ID: &str = "raw-source-turn-id-must-not-escape";
        let error = prepare_transcript(
            Some("claude"),
            None,
            &[
                sourced_turn(ConversationRole::User, "same", SENTINEL_SOURCE_ID),
                sourced_turn(ConversationRole::User, "same", SENTINEL_SOURCE_ID),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            ConversationError::DuplicateSourceTurnId {
                first_sequence: 1,
                duplicate_sequence: 2,
            }
        ));
        let message = error.to_string();
        assert!(!message.contains(SENTINEL_SOURCE_ID), "{message}");
    }

    #[test]
    fn duplicate_content_keeps_distinct_sequence_positions_and_prefixes() {
        let transcript = prepare_transcript(
            None,
            None,
            &[
                turn(ConversationRole::User, "same"),
                turn(ConversationRole::User, "same"),
            ],
        )
        .unwrap();

        assert_eq!(
            transcript.turns[0].source_identity,
            transcript.turns[1].source_identity
        );
        assert_eq!(transcript.turns[0].source_sequence, 1);
        assert_eq!(transcript.turns[1].source_sequence, 2);
        assert_ne!(transcript.prefix_hashes[0], transcript.prefix_hashes[1]);
    }

    #[test]
    fn cumulative_prefix_hashes_are_stable_and_detect_upstream_edits() {
        let transcript = prepare_transcript(
            Some("claude"),
            None,
            &[
                sourced_turn(ConversationRole::User, "Hello", "turn-1"),
                turn(ConversationRole::Assistant, "Hi"),
            ],
        )
        .unwrap();
        assert_eq!(
            transcript.prefix_hashes,
            [
                "sha256:ca96ed7c6bdb43730ad75230ee5ef720f2ab4a68ce4f733c4930ec52c7b8f3e1",
                "sha256:ee7a6cd1a2311b993eb399df184f7455585270e0078cfcac0cbcfe87e0085aa9",
            ]
        );
        assert_eq!(
            transcript.ledger.captured_prefix_hash,
            transcript.prefix_hashes[1]
        );

        let edited = prepare_transcript(
            Some("claude"),
            None,
            &[
                sourced_turn(ConversationRole::User, "Hello!", "turn-1"),
                turn(ConversationRole::Assistant, "Hi"),
            ],
        )
        .unwrap();
        assert_ne!(transcript.prefix_hashes[0], edited.prefix_hashes[0]);
        assert_ne!(transcript.prefix_hashes[1], edited.prefix_hashes[1]);
    }

    #[test]
    fn complete_prefix_appends_only_the_suffix() {
        let first = prepare_transcript(
            Some("Claude"),
            Some(host_identity_hash("claude", "raw-host-id").unwrap()),
            &[
                turn(ConversationRole::User, "one"),
                turn(ConversationRole::Assistant, "two"),
            ],
        )
        .unwrap();
        let second = prepare_transcript(
            Some("claude"),
            first.ledger.host_id_hash.clone(),
            &[
                turn(ConversationRole::User, "one"),
                turn(ConversationRole::Assistant, "two"),
                turn(ConversationRole::User, "three"),
            ],
        )
        .unwrap();

        assert_eq!(
            verify_append(&first.ledger, &first).unwrap(),
            AppendDecision::Unchanged
        );
        assert_eq!(
            verify_append(&first.ledger, &second).unwrap(),
            AppendDecision::AppendFrom(2)
        );
    }

    #[test]
    fn append_rejects_truncation_divergence_and_identity_changes() {
        let host_hash = host_identity_hash("claude", "conversation-7").unwrap();
        let existing = prepare_transcript(
            Some("claude"),
            Some(host_hash.clone()),
            &[
                turn(ConversationRole::User, "one"),
                turn(ConversationRole::Assistant, "two"),
            ],
        )
        .unwrap();
        let truncated = prepare_transcript(
            Some("claude"),
            Some(host_hash.clone()),
            &[turn(ConversationRole::User, "one")],
        )
        .unwrap();
        assert!(matches!(
            verify_append(&existing.ledger, &truncated),
            Err(ConversationError::TruncatedTranscript {
                existing: 2,
                submitted: 1
            })
        ));

        let divergent = prepare_transcript(
            Some("claude"),
            Some(host_hash.clone()),
            &[
                turn(ConversationRole::User, "changed"),
                turn(ConversationRole::Assistant, "two"),
            ],
        )
        .unwrap();
        assert!(matches!(
            verify_append(&existing.ledger, &divergent),
            Err(ConversationError::DivergentTranscript { sequence: 2 })
        ));

        let provider_changed = prepare_transcript(
            Some("openai"),
            Some(host_hash.clone()),
            &[
                turn(ConversationRole::User, "one"),
                turn(ConversationRole::Assistant, "two"),
            ],
        )
        .unwrap();
        assert!(matches!(
            verify_append(&existing.ledger, &provider_changed),
            Err(ConversationError::ProviderConflict)
        ));

        let host_changed = prepare_transcript(
            Some("claude"),
            Some(host_identity_hash("claude", "conversation-8").unwrap()),
            &[
                turn(ConversationRole::User, "one"),
                turn(ConversationRole::Assistant, "two"),
            ],
        )
        .unwrap();
        assert!(matches!(
            verify_append(&existing.ledger, &host_changed),
            Err(ConversationError::HostIdentityConflict)
        ));
    }

    #[test]
    fn ledger_round_trips_as_one_native_toml_table() {
        let transcript = prepare_transcript(
            Some("claude"),
            Some(host_identity_hash("claude", "raw-host-id").unwrap()),
            &[turn(ConversationRole::User, "Hello")],
        )
        .unwrap();
        let mut meta = crate::vault::page::PageMeta::new();

        write_ledger(&mut meta, &transcript.ledger).unwrap();

        let value = meta.extra.get(CONVERSATION_META_KEY).unwrap();
        assert!(matches!(value, toml::Value::Table(_)));
        assert!(!value.to_string().contains("raw-host-id"));
        assert_eq!(read_ledger(&meta).unwrap(), Some(transcript.ledger));
    }

    #[test]
    fn malformed_or_raw_host_ledger_values_are_rejected() {
        let mut malformed = crate::vault::page::PageMeta::new();
        malformed.extra.insert(
            CONVERSATION_META_KEY.to_string(),
            toml::Value::String("not-a-table".to_string()),
        );
        assert!(matches!(
            read_ledger(&malformed),
            Err(ConversationError::InvalidLedger(_))
        ));

        let raw = ConversationLedger {
            provider: Some("claude".to_string()),
            host_id_hash: Some("raw-host-id".to_string()),
            captured_turn_count: 0,
            captured_prefix_hash:
                "sha256:41935828ef706134c1a74404d8242db4eb4ac68b0833fd9a553cb8d465d37ef2"
                    .to_string(),
            last_source_identity: String::new(),
        };
        let mut meta = crate::vault::page::PageMeta::new();
        assert!(matches!(
            write_ledger(&mut meta, &raw),
            Err(ConversationError::InvalidHostIdHash)
        ));
        assert!(!meta.extra.contains_key(CONVERSATION_META_KEY));
    }

    #[test]
    fn markdown_emission_is_exact_for_multiline_callouts() {
        let timestamp = Utc.with_ymd_and_hms(2026, 8, 9, 9, 14, 0).unwrap();
        let transcript = prepare_transcript(
            Some("claude"),
            None,
            &[
                ConversationTurn {
                    role: ConversationRole::User,
                    content: "Hello\n\nworld".to_string(),
                    source_turn_id: Some("turn-1".to_string()),
                    timestamp: Some(timestamp),
                },
                turn(ConversationRole::Assistant, "Hi"),
            ],
        )
        .unwrap();

        assert_eq!(
            render_turns(&transcript.turns),
            concat!(
                "> [!AI-USER source=sha256:4656419a9b9f271090588efaeedaf3504cac8f382d709f7a8efda2118566a841 sequence=1 timestamp=2026-08-09T09:14:00Z]\n",
                "> Hello\n",
                ">\n",
                "> world\n",
                "\n",
                "> [!AI-ASSISTANT source=sha256:147d20a39615d22b72aebe97b08a145773ded1d861f3d6b3e0ae94809a28a4f4 sequence=2]\n",
                "> Hi\n",
            )
        );
    }

    #[test]
    fn marker_is_portable_blockquote_callout_and_append_has_one_separator() {
        let transcript =
            prepare_transcript(None, None, &[turn(ConversationRole::User, "Hello")]).unwrap();
        let rendered = render_turns(&transcript.turns);
        assert!(rendered.starts_with("> [!AI-USER source=sha256:"));
        assert!(rendered.contains(" sequence=1]"));
        assert!(rendered.ends_with("> Hello\n"));
        assert_eq!(
            append_rendered_turns("# Conversation\n\n", &transcript.turns),
            format!("# Conversation\n\n{rendered}")
        );
        assert_eq!(append_rendered_turns("", &transcript.turns), rendered);
        assert_eq!(append_rendered_turns("unchanged", &[]), "unchanged");
    }
}
