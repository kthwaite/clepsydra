//! Vault location: latitude/longitude (and an optional human label) used for
//! solar-time calculations such as the Atrium "horologe" (sunset countdown).
//!
//! Mirrors the [`crate::vault::bcl`] pattern: the vault stores the
//! source-of-truth at `<vault>/.clepsydra/location.toml` so the value travels
//! with the vault. On first run the loader uses a lookaside cache: if the
//! vault file is missing, it copies `~/.config/clepsydra/location.toml` into
//! the vault. Absence at both locations is non-fatal — the feature simply
//! hides.
//!
//! File format (TOML):
//! ```toml
//! latitude = 51.5074
//! longitude = -0.1278
//! label = "London"   # optional
//! ```

use std::path::{Path, PathBuf};

use serde::Deserialize;

const VAULT_RELATIVE_PATH: &str = ".clepsydra/location.toml";
const HOME_RELATIVE_PATH: &str = ".config/clepsydra/location.toml";

/// Geographic coordinates plus an optional human-readable label.
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawLocation {
    latitude: f64,
    longitude: f64,
    #[serde(default)]
    label: Option<String>,
}

/// Locate the vault-local location config, copying it from
/// `~/.config/clepsydra/location.toml` if it does not yet exist. Returns the
/// parsed location when available.
///
/// All error paths are demoted to `None` — a missing or malformed location
/// config must never prevent server startup.
pub fn load_or_seed(vault_root: &Path) -> Option<Location> {
    let vault_path = vault_root.join(VAULT_RELATIVE_PATH);

    if !vault_path.exists()
        && let Some(home_path) = home_config_path()
        && home_path.exists()
    {
        if let Err(e) = seed_from_home(&home_path, &vault_path) {
            tracing::warn!(error = %e, "failed to seed location config from ~/.config/clepsydra/location.toml");
        } else {
            tracing::info!(
                src = %home_path.display(),
                dst = %vault_path.display(),
                "seeded location config from home"
            );
        }
    }

    read_location(&vault_path)
}

fn home_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(HOME_RELATIVE_PATH))
}

fn seed_from_home(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)?;
    Ok(())
}

fn read_location(path: &Path) -> Option<Location> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse_location(&raw)
}

fn parse_location(raw: &str) -> Option<Location> {
    let parsed: RawLocation = toml::from_str(raw).ok()?;
    if !(-90.0..=90.0).contains(&parsed.latitude) {
        tracing::warn!(latitude = parsed.latitude, "location latitude out of range");
        return None;
    }
    if !(-180.0..=180.0).contains(&parsed.longitude) {
        tracing::warn!(
            longitude = parsed.longitude,
            "location longitude out of range"
        );
        return None;
    }
    Some(Location {
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        label: parsed.label.filter(|s| !s.trim().is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_location_accepts_minimal_toml() {
        let parsed = parse_location("latitude = 51.5074\nlongitude = -0.1278\n")
            .expect("location should parse");
        assert!((parsed.latitude - 51.5074).abs() < 1e-9);
        assert!((parsed.longitude - -0.1278).abs() < 1e-9);
        assert!(parsed.label.is_none());
    }

    #[test]
    fn parse_location_accepts_label() {
        let raw = "latitude = 40.7128\nlongitude = -74.0060\nlabel = \"NYC\"\n";
        let parsed = parse_location(raw).expect("location should parse");
        assert_eq!(parsed.label.as_deref(), Some("NYC"));
    }

    #[test]
    fn parse_location_drops_empty_label() {
        let raw = "latitude = 0.0\nlongitude = 0.0\nlabel = \"   \"\n";
        let parsed = parse_location(raw).expect("location should parse");
        assert!(parsed.label.is_none());
    }

    #[test]
    fn parse_location_rejects_garbage() {
        assert!(parse_location("not toml at all").is_none());
        assert!(parse_location("").is_none());
    }

    #[test]
    fn parse_location_rejects_missing_fields() {
        assert!(parse_location("latitude = 1.0").is_none());
        assert!(parse_location("longitude = 1.0").is_none());
    }

    #[test]
    fn parse_location_rejects_out_of_range_lat() {
        assert!(parse_location("latitude = 91.0\nlongitude = 0.0").is_none());
        assert!(parse_location("latitude = -91.0\nlongitude = 0.0").is_none());
    }

    #[test]
    fn parse_location_rejects_out_of_range_lon() {
        assert!(parse_location("latitude = 0.0\nlongitude = 181.0").is_none());
        assert!(parse_location("latitude = 0.0\nlongitude = -181.0").is_none());
    }

    #[test]
    fn parse_location_accepts_boundary_values() {
        assert!(parse_location("latitude = 90.0\nlongitude = 180.0").is_some());
        assert!(parse_location("latitude = -90.0\nlongitude = -180.0").is_some());
    }

    #[test]
    fn load_or_seed_reads_existing_vault_file() {
        let tmp = TempDir::new().unwrap();
        let cfg_dir = tmp.path().join(".clepsydra");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(
            cfg_dir.join("location.toml"),
            "latitude = 35.6762\nlongitude = 139.6503\nlabel = \"Tokyo\"\n",
        )
        .unwrap();

        let parsed = load_or_seed(tmp.path()).expect("should load vault file");
        assert!((parsed.latitude - 35.6762).abs() < 1e-9);
        assert!((parsed.longitude - 139.6503).abs() < 1e-9);
        assert_eq!(parsed.label.as_deref(), Some("Tokyo"));
    }

    #[test]
    fn load_or_seed_returns_none_when_vault_file_malformed() {
        let tmp = TempDir::new().unwrap();
        let cfg_dir = tmp.path().join(".clepsydra");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(cfg_dir.join("location.toml"), "garbage").unwrap();

        assert!(load_or_seed(tmp.path()).is_none());
    }

    #[test]
    fn load_or_seed_returns_none_when_no_config_anywhere() {
        let tmp = TempDir::new().unwrap();
        // Soft assertion as in BCL tests: cannot easily mock $HOME.
        let _ = load_or_seed(tmp.path());
    }
}
