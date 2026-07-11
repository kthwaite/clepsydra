//! Parsing and target-building for `clepsydra://` / `obsidian://` deep links.
//!
//! Grammar (locked by design review, 2026-07-11):
//! - `clepsydra://page/<target>` — verb-first; only `page` exists today.
//! - `obsidian://open?vault=X&file=Y` and `obsidian://vault/<vault>/<note>` —
//!   compat dialect. `path=` and other actions are unsupported.

use std::fmt;
use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

/// Everything except RFC 3986 unreserved characters gets percent-encoded when
/// a scheme URL is embedded as a query value.
const QUERY_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLink {
    /// Target exactly as it appeared in the URL (still percent-encoded).
    pub target_raw: String,
    /// Percent-decoded target.
    pub target_decoded: String,
    /// Vault name carried by obsidian:// links; `None` for clepsydra:// links.
    pub vault: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    UnsupportedScheme,
    UnsupportedAction(String),
    MissingTarget,
    MissingFileParam,
    Malformed(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedScheme => write!(
                f,
                "unsupported scheme (expected clepsydra:// or obsidian://)"
            ),
            Self::UnsupportedAction(a) => write!(f, "unsupported action: {a}"),
            Self::MissingTarget => write!(f, "link has no target"),
            Self::MissingFileParam => {
                write!(f, "obsidian://open link is missing the file= parameter")
            }
            Self::Malformed(m) => write!(f, "malformed link: {m}"),
        }
    }
}

impl std::error::Error for ParseError {}

fn decode(raw: &str) -> Result<String, ParseError> {
    percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| ParseError::Malformed("invalid percent-encoding".to_string()))
}

/// Split off a `#fragment` suffix, if any.
fn strip_fragment(s: &str) -> &str {
    s.split_once('#').map_or(s, |(head, _)| head)
}

pub fn parse(url: &str) -> Result<ParsedLink, ParseError> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| ParseError::Malformed("missing ://".to_string()))?;
    let rest = strip_fragment(rest);

    match scheme.to_ascii_lowercase().as_str() {
        "clepsydra" => {
            let (verb, target) = rest.split_once('/').unwrap_or((rest, ""));
            if verb != "page" {
                if verb.is_empty() {
                    return Err(ParseError::MissingTarget);
                }
                return Err(ParseError::UnsupportedAction(verb.to_string()));
            }
            // Ignore any query string; no page parameters exist yet.
            let target = target.split_once('?').map_or(target, |(head, _)| head);
            if target.is_empty() {
                return Err(ParseError::MissingTarget);
            }
            Ok(ParsedLink {
                target_raw: target.to_string(),
                target_decoded: decode(target)?,
                vault: None,
            })
        }
        "obsidian" => {
            if let Some(query) = rest.strip_prefix("open?") {
                let mut vault = None;
                let mut file = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    match k {
                        "vault" => vault = Some(decode(v)?),
                        "file" => file = Some(decode(v)?),
                        _ => {}
                    }
                }
                let file = file.ok_or(ParseError::MissingFileParam)?;
                Ok(ParsedLink {
                    target_raw: file.clone(),
                    target_decoded: file,
                    vault,
                })
            } else if let Some(rest) = rest.strip_prefix("vault/") {
                let (vault, target) = rest.split_once('/').ok_or(ParseError::MissingTarget)?;
                if target.is_empty() {
                    return Err(ParseError::MissingTarget);
                }
                Ok(ParsedLink {
                    target_raw: target.to_string(),
                    target_decoded: decode(target)?,
                    vault: Some(decode(vault)?),
                })
            } else {
                let action = rest.split(['/', '?']).next().unwrap_or("").to_string();
                Err(ParseError::UnsupportedAction(action))
            }
        }
        _ => Err(ParseError::UnsupportedScheme),
    }
}

/// An obsidian:// link's vault name is accepted when it matches the basename
/// of the configured vault root or one of the configured aliases.
pub fn vault_matches(vault: Option<&str>, vault_root: &Path, aliases: &[String]) -> bool {
    let Some(name) = vault else { return true };
    if vault_root.file_name().is_some_and(|b| b == name) {
        return true;
    }
    aliases.iter().any(|a| a == name)
}

/// Build the local HTTP URL the OS handler opens for a raw scheme URL.
pub fn deeplink_http_url(base: &str, raw_url: &str) -> String {
    format!(
        "{base}/deeplink?url={}",
        utf8_percent_encode(raw_url, QUERY_VALUE)
    )
}
