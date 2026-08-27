//! The page `kind` vocabulary and its folder relationships.
//!
//! Resolution precedence: declared (frontmatter `type:`) -> inferred
//! (top-level folder) -> NOTE. See docs/adr/0001-metadata-projected-folder-layout.md.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The single type discriminator of a page. Closed enum; expand by editing here.
///
/// Exposed in the OpenAPI document as an UPPERCASE string enum (matching the
/// custom `Serialize` impl below) so the UI's generated types carry the full
/// vocabulary instead of hardcoding it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, utoipa::ToSchema)]
#[schema(rename_all = "UPPERCASE")]
pub enum Kind {
    Note,
    Project,
    Journal,
    Todo,
    Quote,
    Book,
    Capture,
    Code,
    Person,
    Task,
    Cycle,
    Recipe,
    Meeting,
    #[schema(rename = "ONE_ON_ONE")]
    OneOnOne,
    Archive,
    #[schema(rename = "AI_CONVERSATION")]
    AiConversation,
}

impl Kind {
    /// The one canonical folder a page of this kind is filed under (lowercase,
    /// plural where natural). Distinct from the many-to-one inference map.
    pub fn canonical_folder(self) -> &'static str {
        match self {
            Kind::Note => "notes",
            Kind::Project => "projects",
            Kind::Journal => "journals",
            Kind::Todo => "todos",
            Kind::Quote => "quotes",
            Kind::Book => "books",
            Kind::Capture => "captures",
            Kind::Code => "code",
            Kind::Person => "people",
            Kind::Task => "tasks",
            Kind::Cycle => "cycles",
            Kind::Recipe => "recipes",
            Kind::Meeting => "meetings",
            Kind::OneOnOne => "one-on-ones",
            // Must stay in step with `ArchiveConfig::default_path_prefix`;
            // a mismatch would relocate every existing archived page.
            Kind::Archive => "archive",
            Kind::AiConversation => "conversations",
        }
    }

    /// The canonical lowercase tag derived from this kind.
    pub const fn computed_tag(self) -> &'static str {
        match self {
            Kind::Note => "note",
            Kind::Project => "project",
            Kind::Journal => "journal",
            Kind::Todo => "todo",
            Kind::Quote => "quote",
            Kind::Book => "book",
            Kind::Capture => "capture",
            Kind::Code => "code",
            Kind::Person => "person",
            Kind::Task => "task",
            Kind::Cycle => "cycle",
            Kind::Recipe => "recipe",
            Kind::Meeting => "meeting",
            Kind::OneOnOne => "one_on_one",
            Kind::Archive => "archive",
            Kind::AiConversation => "ai_conversation",
        }
    }

    /// The UPPERCASE wire/storage token.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Note => "NOTE",
            Kind::Project => "PROJECT",
            Kind::Journal => "JOURNAL",
            Kind::Todo => "TODO",
            Kind::Quote => "QUOTE",
            Kind::Book => "BOOK",
            Kind::Capture => "CAPTURE",
            Kind::Code => "CODE",
            Kind::Person => "PERSON",
            Kind::Task => "TASK",
            Kind::Cycle => "CYCLE",
            Kind::Recipe => "RECIPE",
            Kind::Meeting => "MEETING",
            Kind::OneOnOne => "ONE_ON_ONE",
            Kind::Archive => "ARCHIVE",
            Kind::AiConversation => "AI_CONVERSATION",
        }
    }

    /// Parse a kind token case-insensitively. Unknown -> None.
    pub fn from_token(s: &str) -> Option<Kind> {
        match s.trim().to_ascii_uppercase().as_str() {
            "NOTE" => Some(Kind::Note),
            "PROJECT" => Some(Kind::Project),
            "JOURNAL" => Some(Kind::Journal),
            "TODO" => Some(Kind::Todo),
            "QUOTE" => Some(Kind::Quote),
            "BOOK" => Some(Kind::Book),
            "CAPTURE" => Some(Kind::Capture),
            "CODE" => Some(Kind::Code),
            "PERSON" => Some(Kind::Person),
            "TASK" => Some(Kind::Task),
            "CYCLE" => Some(Kind::Cycle),
            "RECIPE" => Some(Kind::Recipe),
            "MEETING" => Some(Kind::Meeting),
            // `1:1` and `1-1` are how the kind is spoken and written; accept
            // them as spellings of the canonical ONE_ON_ONE token.
            "ONE_ON_ONE" | "ONE-ON-ONE" | "ONEONONE" | "1:1" | "1-1" | "1ON1" => {
                Some(Kind::OneOnOne)
            }
            "ARCHIVE" => Some(Kind::Archive),
            "AI_CONVERSATION" => Some(Kind::AiConversation),
            _ => None,
        }
    }

    /// Map a top-level folder name to a kind, accepting synonyms. Case-folds
    /// the input. Unknown folder -> None (caller falls back to NOTE).
    pub fn from_folder(folder: &str) -> Option<Kind> {
        match folder.to_ascii_lowercase().as_str() {
            "notes" | "note" => Some(Kind::Note),
            "projects" | "project" => Some(Kind::Project),
            "journals" | "journal" | "daily" | "dailies" | "diary" => Some(Kind::Journal),
            "todos" | "todo" => Some(Kind::Todo),
            "quotes" | "quote" => Some(Kind::Quote),
            "books" | "book" | "reading" | "library" => Some(Kind::Book),
            "captures" | "capture" | "inbox" | "clippings" => Some(Kind::Capture),
            "code" | "snippets" => Some(Kind::Code),
            "people" | "persons" | "person" | "contacts" => Some(Kind::Person),
            "tasks" | "task" => Some(Kind::Task),
            "cycles" | "cycle" | "sprints" | "sprint" => Some(Kind::Cycle),
            "recipes" | "recipe" => Some(Kind::Recipe),
            "meetings" | "meeting" => Some(Kind::Meeting),
            "one-on-ones" | "one-on-one" | "one-to-ones" | "one-to-one" | "1-1s" | "1-1"
            | "1on1s" | "1on1" | "121s" | "121" => Some(Kind::OneOnOne),
            "archive" | "archives" | "archived" => Some(Kind::Archive),
            "conversations" | "conversation" | "chats" => Some(Kind::AiConversation),
            _ => None,
        }
    }
}

impl Kind {
    /// Whether pages of this kind protect their body from edits unless the
    /// page says otherwise.
    ///
    /// Only archives do. Their body is generated from a captured snapshot and
    /// `archive.content_hash` in the frontmatter claims to describe it; editing
    /// the body silently makes that claim false. Metadata stays editable — an
    /// archive still needs tagging and filing like any other page.
    pub const fn readonly_by_default(self) -> bool {
        matches!(self, Kind::Archive)
    }
}

/// Whether `tag` is the computed classification for `kind`.
pub fn is_computed_tag(kind: Kind, tag: &str) -> bool {
    tag.trim().eq_ignore_ascii_case(kind.computed_tag())
}

/// Return stored tags that remain user-editable for `kind`.
///
/// Redundant computed values and later normalized duplicates are omitted while
/// first-seen spelling and order are retained.
pub fn editable_tags<'a>(kind: Kind, stored: &'a [String]) -> Vec<&'a str> {
    let mut editable: Vec<&'a str> = Vec::with_capacity(stored.len());

    for tag in stored {
        let normalized = tag.trim();
        if is_computed_tag(kind, normalized)
            || editable
                .iter()
                .any(|seen| seen.trim().eq_ignore_ascii_case(normalized))
        {
            continue;
        }
        editable.push(tag.as_str());
    }

    editable
}

/// Merge editable stored tags with the canonical computed classification.
pub fn effective_tags(kind: Kind, stored: &[String]) -> Vec<String> {
    let mut effective: Vec<String> = Vec::with_capacity(stored.len() + 1);

    for tag in stored {
        let normalized = tag.trim();
        if is_computed_tag(kind, normalized)
            || effective
                .iter()
                .any(|seen| seen.trim().eq_ignore_ascii_case(normalized))
        {
            continue;
        }
        effective.push(tag.clone());
    }

    effective.push(kind.computed_tag().to_string());
    effective
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for Kind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Kind {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Kind::from_token(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown kind: {raw}")))
    }
}

/// Resolve a page's kind from its path and any declared kind.
/// Returns the resolved kind and whether it was inferred (declared absent).
pub fn resolve(path: &str, declared: Option<Kind>) -> (Kind, bool) {
    if let Some(k) = declared {
        return (k, false);
    }
    let top = path.trim_start_matches('/').split('/').next().unwrap_or("");
    let inferred = Kind::from_folder(&top.to_ascii_lowercase()).unwrap_or(Kind::Note);
    (inferred, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_token_is_case_insensitive() {
        assert_eq!(Kind::from_token("quote"), Some(Kind::Quote));
        assert_eq!(Kind::from_token("  QUOTE "), Some(Kind::Quote));
        assert_eq!(
            Kind::from_token("ai_conversation"),
            Some(Kind::AiConversation)
        );
        assert_eq!(Kind::from_token("recipe"), Some(Kind::Recipe));
    }

    #[test]
    fn canonical_folder_is_lowercase_plural() {
        assert_eq!(Kind::Journal.canonical_folder(), "journals");
        assert_eq!(Kind::Todo.canonical_folder(), "todos");
        assert_eq!(Kind::Person.canonical_folder(), "people");
        assert_eq!(Kind::Code.canonical_folder(), "code");
        assert_eq!(Kind::AiConversation.canonical_folder(), "conversations");
        assert_eq!(Kind::Recipe.as_str(), "RECIPE");
        assert_eq!(Kind::Recipe.canonical_folder(), "recipes");
        assert_eq!(Kind::from_folder("recipe"), Some(Kind::Recipe));
        assert_eq!(Kind::from_folder("recipes"), Some(Kind::Recipe));
    }

    #[test]
    fn declared_kind_wins_and_is_not_inferred() {
        let (k, inferred) = resolve("projects/x.md", Some(Kind::Quote));
        assert_eq!(k, Kind::Quote);
        assert!(!inferred);
        let (k, inferred) = resolve("notes/x.md", Some(Kind::AiConversation));
        assert_eq!(k, Kind::AiConversation);
        assert!(!inferred);
    }

    #[test]
    fn folder_is_inferred_with_synonyms() {
        assert_eq!(
            resolve("journals/2026-05-31.md", None),
            (Kind::Journal, true)
        );
        assert_eq!(resolve("diary/x.md", None), (Kind::Journal, true));
        assert_eq!(resolve("tasks/x.md", None), (Kind::Task, true));
        for folder in ["conversations", "conversation", "chats"] {
            assert_eq!(
                resolve(&format!("{folder}/x.md"), None),
                (Kind::AiConversation, true)
            );
        }
    }

    #[test]
    fn unknown_or_rootless_folder_infers_note() {
        assert_eq!(resolve("misc/x.md", None), (Kind::Note, true));
        assert_eq!(resolve("toplevel.md", None), (Kind::Note, true));
    }

    #[test]
    fn as_str_and_from_token_are_symmetric() {
        let all = [
            Kind::Note,
            Kind::Project,
            Kind::Journal,
            Kind::Todo,
            Kind::Quote,
            Kind::Book,
            Kind::Capture,
            Kind::Code,
            Kind::Person,
            Kind::Task,
            Kind::Cycle,
            Kind::Recipe,
            Kind::Meeting,
            Kind::OneOnOne,
            Kind::AiConversation,
        ];
        for k in all {
            assert_eq!(
                Kind::from_token(k.as_str()),
                Some(k),
                "from_token(as_str()) round-trip failed for {k:?}"
            );
        }
        assert_eq!(Kind::Task.canonical_folder(), "tasks");
        assert_eq!(Kind::Cycle.canonical_folder(), "cycles");
        assert_eq!(Kind::from_folder("tasks"), Some(Kind::Task));
        assert_eq!(Kind::from_folder("todos"), Some(Kind::Todo));
        assert_eq!(Kind::from_folder("sprints"), Some(Kind::Cycle));
        assert_eq!(
            Kind::from_folder("conversations"),
            Some(Kind::AiConversation)
        );
        assert_eq!(
            Kind::from_folder("conversation"),
            Some(Kind::AiConversation)
        );
        assert_eq!(Kind::from_folder("chats"), Some(Kind::AiConversation));
    }

    #[test]
    fn computed_tags_are_canonical_lowercase_kind_tokens() {
        let expected = [
            (Kind::Note, "note"),
            (Kind::Project, "project"),
            (Kind::Journal, "journal"),
            (Kind::Todo, "todo"),
            (Kind::Quote, "quote"),
            (Kind::Book, "book"),
            (Kind::Capture, "capture"),
            (Kind::Code, "code"),
            (Kind::Person, "person"),
            (Kind::Task, "task"),
            (Kind::Cycle, "cycle"),
            (Kind::Recipe, "recipe"),
            (Kind::Meeting, "meeting"),
            (Kind::OneOnOne, "one_on_one"),
            (Kind::AiConversation, "ai_conversation"),
        ];

        for (kind, tag) in expected {
            assert_eq!(kind.computed_tag(), tag, "wrong computed tag for {kind:?}");
        }
    }

    #[test]
    fn computed_tag_matching_trims_and_folds_ascii_case() {
        assert!(is_computed_tag(Kind::Journal, "\t JoUrNaL \n"));
        assert!(is_computed_tag(Kind::AiConversation, " AI_CONVERSATION "));
        assert!(!is_computed_tag(Kind::Journal, "journal-entry"));
        assert!(!is_computed_tag(Kind::Note, " journal "));
    }

    #[test]
    fn legacy_computed_tags_and_editable_duplicates_collapse_in_stable_order() {
        let stored = vec![
            "Research".to_string(),
            " JOURNAL ".to_string(),
            " research ".to_string(),
            "Rust".to_string(),
            "journal".to_string(),
            "RUST ".to_string(),
            "Drafts".to_string(),
        ];

        assert_eq!(
            editable_tags(Kind::Journal, &stored),
            ["Research", "Rust", "Drafts"]
        );
        assert_eq!(
            effective_tags(Kind::Journal, &stored),
            ["Research", "Rust", "Drafts", "journal"]
        );
    }

    #[test]
    fn same_spelling_tag_is_ordinary_for_a_different_kind() {
        let stored = vec![
            "journal".to_string(),
            "Research".to_string(),
            " JOURNAL ".to_string(),
        ];

        assert_eq!(editable_tags(Kind::Note, &stored), ["journal", "Research"]);
        assert_eq!(
            effective_tags(Kind::Note, &stored),
            ["journal", "Research", "note"]
        );
    }

    #[test]
    fn serde_round_trips() {
        let encoded = serde_json::to_string(&Kind::Quote).unwrap();
        assert_eq!(encoded, "\"QUOTE\"");
        let decoded: Kind = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, Kind::Quote);

        let encoded = serde_json::to_string(&Kind::Recipe).unwrap();
        assert_eq!(encoded, "\"RECIPE\"");
        let decoded: Kind = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, Kind::Recipe);

        let encoded = serde_json::to_string(&Kind::AiConversation).unwrap();
        assert_eq!(encoded, "\"AI_CONVERSATION\"");
        let decoded: Kind = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, Kind::AiConversation);
    }

    #[test]
    fn meeting_kinds_have_their_own_folders_and_tags() {
        assert_eq!(Kind::Meeting.as_str(), "MEETING");
        assert_eq!(Kind::Meeting.canonical_folder(), "meetings");
        assert_eq!(Kind::Meeting.computed_tag(), "meeting");
        assert_eq!(Kind::OneOnOne.as_str(), "ONE_ON_ONE");
        assert_eq!(Kind::OneOnOne.canonical_folder(), "one-on-ones");
        assert_eq!(Kind::OneOnOne.computed_tag(), "one_on_one");
    }

    #[test]
    fn one_on_one_accepts_the_spellings_people_actually_type() {
        for token in [
            "ONE_ON_ONE",
            "one_on_one",
            "one-on-one",
            " 1:1 ",
            "1-1",
            "1on1",
        ] {
            assert_eq!(
                Kind::from_token(token),
                Some(Kind::OneOnOne),
                "token {token:?} should parse as ONE_ON_ONE"
            );
        }
        assert_eq!(Kind::from_token("meeting"), Some(Kind::Meeting));
    }

    #[test]
    fn meeting_folders_are_inferred_with_synonyms() {
        assert_eq!(
            resolve("meetings/2026-08-27.standup.ab12cd34.md", None),
            (Kind::Meeting, true)
        );
        for folder in [
            "one-on-ones",
            "one-on-one",
            "one-to-ones",
            "1-1s",
            "1on1",
            "121s",
        ] {
            assert_eq!(
                resolve(&format!("{folder}/x.md"), None),
                (Kind::OneOnOne, true),
                "folder {folder:?} should infer ONE_ON_ONE"
            );
        }
    }

    #[test]
    fn meeting_kinds_serde_round_trip() {
        assert_eq!(
            serde_json::to_string(&Kind::Meeting).unwrap(),
            "\"MEETING\""
        );
        assert_eq!(
            serde_json::to_string(&Kind::OneOnOne).unwrap(),
            "\"ONE_ON_ONE\""
        );
        let decoded: Kind = serde_json::from_str("\"ONE_ON_ONE\"").unwrap();
        assert_eq!(decoded, Kind::OneOnOne);
    }
}
