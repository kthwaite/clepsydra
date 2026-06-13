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
            _ => None,
        }
    }
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
        assert_eq!(Kind::from_token("recipe"), None);
    }

    #[test]
    fn canonical_folder_is_lowercase_plural() {
        assert_eq!(Kind::Journal.canonical_folder(), "journals");
        assert_eq!(Kind::Todo.canonical_folder(), "todos");
        assert_eq!(Kind::Person.canonical_folder(), "people");
        assert_eq!(Kind::Code.canonical_folder(), "code");
    }

    #[test]
    fn declared_kind_wins_and_is_not_inferred() {
        let (k, inferred) = resolve("projects/x.md", Some(Kind::Quote));
        assert_eq!(k, Kind::Quote);
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
    }

    #[test]
    fn serde_round_trips() {
        let encoded = serde_json::to_string(&Kind::Quote).unwrap();
        assert_eq!(encoded, "\"QUOTE\"");
        let decoded: Kind = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, Kind::Quote);
    }
}
