//! Idempotent "managed block" for files like `.gitignore` and
//! `.gitattributes`: a set of lines `clep sync init` needs present, tracked
//! between two marker comments so re-running never duplicates them and any
//! existing user content is left untouched.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::SyncError;
use clep_vault::atomic_file::{atomic_create, atomic_replace};

pub const BLOCK_START: &str = "# >>> clep sync (managed) >>>";
pub const BLOCK_END: &str = "# <<< clep sync (managed) <<<";

/// Ensure every `lines` entry is present in `path`: lines already anywhere in
/// the file are left alone; missing ones are appended inside the managed
/// block (created at EOF when absent). Returns the number of lines added.
pub fn upsert_managed_block(path: &Path, lines: &[&str]) -> Result<usize, SyncError> {
    let existed = path.is_file();
    let text = if existed {
        fs::read_to_string(path).map_err(|e| SyncError::io(path, e))?
    } else {
        String::new()
    };

    let existing: HashSet<&str> = text.lines().collect();
    let missing: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| !existing.contains(line))
        .collect();
    if missing.is_empty() {
        return Ok(0);
    }

    // The existing text is spliced, never re-joined from its lines: every
    // byte already in the file — line endings included — stays as it was,
    // and the added lines take the file's own line ending.
    let eol = line_ending(&text);
    let mut offset = 0;
    let (mut start, mut end) = (None, None);
    for line in text.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if content == BLOCK_START && start.is_none() {
            start = Some(offset);
        } else if content == BLOCK_END && end.is_none() {
            end = Some(offset);
        }
        offset += line.len();
    }
    let added: String = missing.iter().flat_map(|line| [line, eol]).collect();

    let mut out = text.clone();
    match (start, end) {
        (Some(start), Some(end)) if start < end => {
            // Insert the missing lines just before the closing marker,
            // keeping everything else (including any lines a user added
            // inside the block) exactly where it was.
            out.insert_str(end, &added);
        }
        _ => {
            // No existing block (or a malformed one): append a fresh block
            // at EOF, after any existing content.
            if !out.is_empty() && !out.ends_with('\n') {
                out.push_str(eol);
            }
            out.push_str(BLOCK_START);
            out.push_str(eol);
            out.push_str(&added);
            out.push_str(BLOCK_END);
            out.push_str(eol);
        }
    }
    if !out.ends_with('\n') {
        out.push_str(eol);
    }

    if existed {
        atomic_replace(path, out.as_bytes()).map_err(|e| SyncError::io(path, e.into_inner()))?;
    } else {
        atomic_create(path, out.as_bytes()).map_err(|e| SyncError::io(path, e.into_inner()))?;
    }

    Ok(missing.len())
}

/// `\r\n` when most of `text`'s lines end that way, else `\n`.
fn line_ending(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf { "\r\n" } else { "\n" }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn creates_file_with_block_and_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".gitignore");
        assert_eq!(upsert_managed_block(&path, &["a", "b"]).unwrap(), 2);
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "# >>> clep sync (managed) >>>\na\nb\n# <<< clep sync (managed) <<<\n"
        );
        assert_eq!(upsert_managed_block(&path, &["a", "b"]).unwrap(), 0);
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn preserves_user_lines_and_skips_ones_already_present() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".gitignore");
        fs::write(&path, "*.log\n.DS_Store\n").unwrap();
        assert_eq!(
            upsert_managed_block(&path, &[".DS_Store", "x/"]).unwrap(),
            1
        );
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("*.log\n.DS_Store\n"));
        assert!(
            text.contains("# >>> clep sync (managed) >>>\nx/\n# <<< clep sync (managed) <<<\n")
        );
        assert_eq!(text.matches(".DS_Store").count(), 1);
    }

    #[test]
    fn appends_missing_lines_inside_an_existing_block() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".gitattributes");
        fs::write(
            &path,
            "# >>> clep sync (managed) >>>\nold\n# <<< clep sync (managed) <<<\nuser-after\n",
        )
        .unwrap();
        assert_eq!(upsert_managed_block(&path, &["old", "new"]).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# >>> clep sync (managed) >>>\nold\nnew\n# <<< clep sync (managed) <<<\nuser-after\n"
        );
    }

    #[test]
    fn a_crlf_file_keeps_its_bytes_and_gains_crlf_lines() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".gitignore");
        fs::write(&path, "*.log\r\nbuild/\r\n").unwrap();
        assert_eq!(upsert_managed_block(&path, &["build/", "x/"]).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "*.log\r\nbuild/\r\n# >>> clep sync (managed) >>>\r\nx/\r\n# <<< clep sync (managed) <<<\r\n"
        );
        // Into the existing block, again without touching any other byte.
        assert_eq!(upsert_managed_block(&path, &["x/", "y/"]).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "*.log\r\nbuild/\r\n# >>> clep sync (managed) >>>\r\nx/\r\ny/\r\n# <<< clep sync (managed) <<<\r\n"
        );
    }

    #[test]
    fn a_block_that_ends_the_file_unterminated_gains_a_final_newline() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".gitignore");
        fs::write(
            &path,
            "# >>> clep sync (managed) >>>\n# <<< clep sync (managed) <<<",
        )
        .unwrap();
        assert_eq!(upsert_managed_block(&path, &["x/"]).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# >>> clep sync (managed) >>>\nx/\n# <<< clep sync (managed) <<<\n"
        );
    }

    #[test]
    fn a_file_without_a_final_newline_is_terminated_before_the_block() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".gitignore");
        fs::write(&path, "*.log").unwrap();
        assert_eq!(upsert_managed_block(&path, &["x/"]).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "*.log\n# >>> clep sync (managed) >>>\nx/\n# <<< clep sync (managed) <<<\n"
        );
    }
}
