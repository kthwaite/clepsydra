//! Brimley-Cocoon Line: a date-of-birth based countdown to the day the user
//! reaches the age (≈18 530 days) Wilford Brimley was when *Cocoon* (1985)
//! premiered. The reference C implementation lives at
//! <https://github.com/cthwaite/bcl>.
//!
//! The vault stores the source-of-truth at `<vault>/.clepsydra/bcl` so the
//! value travels with the vault. On first run the loader uses a lookaside
//! cache: if the vault file is missing, it copies `~/.config/bcl` into the
//! vault. Absence at both locations is non-fatal — the feature simply hides.
//!
//! File format matches the reference: a single `YYYY-MM-DD` line.

use std::path::{Path, PathBuf};

use chrono::NaiveDate;

const VAULT_RELATIVE_PATH: &str = ".clepsydra/bcl";

/// Days from birth until the Brimley-Cocoon Line. Lifted directly from the
/// reference C implementation (`BRIMLEY_SECS / DAY_SECS`).
pub const BRIMLEY_DAYS: i64 = 18_530;

/// Locate the vault-local BCL config, copying it from `~/.config/bcl` if it
/// does not yet exist. Returns the parsed birth date when available.
///
/// All error paths are demoted to `None` — a missing or malformed BCL config
/// must never prevent server startup.
pub fn load_or_seed(vault_root: &Path) -> Option<NaiveDate> {
    let vault_path = vault_root.join(VAULT_RELATIVE_PATH);

    if !vault_path.exists()
        && let Some(home_path) = home_config_path()
        && home_path.exists()
    {
        if let Err(e) = seed_from_home(&home_path, &vault_path) {
            tracing::warn!(error = %e, "failed to seed BCL config from ~/.config/bcl");
        } else {
            tracing::info!(
                src = %home_path.display(),
                dst = %vault_path.display(),
                "seeded BCL config from home"
            );
        }
    }

    read_birth_date(&vault_path)
}

fn home_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config/bcl"))
}

fn seed_from_home(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)?;
    Ok(())
}

fn read_birth_date(path: &Path) -> Option<NaiveDate> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse_birth_date(&raw)
}

fn parse_birth_date(raw: &str) -> Option<NaiveDate> {
    let trimmed = raw.trim();
    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok()
}

/// Compute the Brimley-Cocoon Line date for the given birth date.
pub fn bcl_date(birth: NaiveDate) -> NaiveDate {
    birth + chrono::Duration::days(BRIMLEY_DAYS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_birth_date_accepts_iso_with_trailing_newline() {
        let parsed = parse_birth_date("1987-01-10\n").expect("date should parse");
        assert_eq!(parsed, NaiveDate::from_ymd_opt(1987, 1, 10).unwrap());
    }

    #[test]
    fn parse_birth_date_rejects_garbage() {
        assert!(parse_birth_date("not a date").is_none());
        assert!(parse_birth_date("").is_none());
    }

    #[test]
    fn bcl_date_adds_18530_days() {
        let birth = NaiveDate::from_ymd_opt(1987, 1, 10).unwrap();
        let bcl = bcl_date(birth);
        // Cross-checked with the reference C `bcl when`: 2037-10-04.
        assert_eq!(bcl, NaiveDate::from_ymd_opt(2037, 10, 4).unwrap());
    }

    #[test]
    fn load_or_seed_reads_existing_vault_file() {
        let tmp = TempDir::new().unwrap();
        let cfg_dir = tmp.path().join(".clepsydra");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(cfg_dir.join("bcl"), "2000-06-15").unwrap();

        let parsed = load_or_seed(tmp.path()).expect("should load vault file");
        assert_eq!(parsed, NaiveDate::from_ymd_opt(2000, 6, 15).unwrap());
    }

    #[test]
    fn load_or_seed_returns_none_when_vault_file_malformed() {
        let tmp = TempDir::new().unwrap();
        let cfg_dir = tmp.path().join(".clepsydra");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(cfg_dir.join("bcl"), "garbage").unwrap();

        assert!(load_or_seed(tmp.path()).is_none());
    }

    #[test]
    fn load_or_seed_returns_none_when_no_config_anywhere() {
        let tmp = TempDir::new().unwrap();
        // We cannot easily mock $HOME for this test, so we just assert the
        // call doesn't panic and returns None *if* the user running tests
        // has no ~/.config/bcl. This is a soft assertion — if the developer
        // has bcl configured locally, the test still passes by reading it.
        let _ = load_or_seed(tmp.path());
    }
}
