//! Idempotent "managed block" for files like `.gitignore` and
//! `.gitattributes`: a set of lines `clep sync init` needs present, tracked
//! between two marker comments so re-running never duplicates them and any
//! existing user content is left untouched.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::SyncError;
use crate::vault::atomic_file::{atomic_create, atomic_replace};

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

    let file_lines: Vec<&str> = text.lines().collect();
    let start = file_lines.iter().position(|&l| l == BLOCK_START);
    let end = file_lines.iter().position(|&l| l == BLOCK_END);

    let mut new_lines: Vec<&str> = Vec::with_capacity(file_lines.len() + missing.len() + 2);
    match (start, end) {
        (Some(start), Some(end)) if start < end => {
            // Insert the missing lines just before the closing marker,
            // keeping everything else (including any lines a user added
            // inside the block) exactly where it was.
            new_lines.extend_from_slice(&file_lines[..end]);
            new_lines.extend_from_slice(&missing);
            new_lines.extend_from_slice(&file_lines[end..]);
        }
        _ => {
            // No existing block (or a malformed one): append a fresh block
            // at EOF, after any existing content.
            new_lines.extend_from_slice(&file_lines);
            new_lines.push(BLOCK_START);
            new_lines.extend_from_slice(&missing);
            new_lines.push(BLOCK_END);
        }
    }

    let mut out = new_lines.join("\n");
    out.push('\n');

    if existed {
        atomic_replace(path, out.as_bytes()).map_err(|e| SyncError::io(path, e.into_inner()))?;
    } else {
        atomic_create(path, out.as_bytes()).map_err(|e| SyncError::io(path, e.into_inner()))?;
    }

    Ok(missing.len())
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
}
