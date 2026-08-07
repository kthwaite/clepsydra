use std::fs;

use base64::prelude::{BASE64_STANDARD, Engine as _};
use clepsydra::vault::keyring::{KeyringError, load_keyring, rewrap_identity, setup_keyring};
use tempfile::TempDir;

const KEY_ID: &str = "019fd000-0000-7000-8000-000000000501";
const ARMOR: &str = include_str!("support/fixtures/private-note.age");

fn recipient() -> String {
    format!("age1{}", "q".repeat(58))
}

fn armor_variant(marker: &[u8]) -> String {
    let mut decoded = b"age-encryption.org/v1\n".to_vec();
    decoded.extend_from_slice(marker);
    let encoded = BASE64_STANDARD.encode(decoded);
    let payload = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN AGE ENCRYPTED FILE-----\n{payload}\n-----END AGE ENCRYPTED FILE-----\n")
}

fn root() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    fs::create_dir_all(root.join(".clepsydra")).unwrap();
    (tmp, root)
}

#[test]
fn missing_keyring_loads_as_uninitialized() {
    let (_tmp, root) = root();

    assert!(load_keyring(&root).unwrap().is_none());
}

#[test]
fn first_setup_and_read_round_trip_public_metadata_and_wrapped_armor() {
    let (_tmp, root) = root();
    let recipient = recipient();

    let created = setup_keyring(&root, KEY_ID, &recipient, Some(ARMOR)).unwrap();
    assert_eq!(created.keyring.version, 1);
    assert_eq!(created.keyring.active_key_id, KEY_ID);
    assert_eq!(created.keyring.keys.len(), 1);
    assert_eq!(created.keyring.keys[0].id, KEY_ID);
    assert_eq!(created.keyring.keys[0].recipient, recipient);
    assert_eq!(
        created.keyring.keys[0].wrapped_identity_file.as_deref(),
        Some("019fd000-0000-7000-8000-000000000501.identity.age")
    );
    assert_eq!(created.wrapped_identity.as_deref(), Some(ARMOR));
    assert_eq!(created.revision.len(), 64);

    let loaded = load_keyring(&root).unwrap().unwrap();
    assert_eq!(loaded, created);

    let metadata = fs::read_to_string(root.join(".clepsydra/crypto/keyring.toml")).unwrap();
    assert!(metadata.contains(&recipient));
    assert!(!metadata.contains("BEGIN AGE ENCRYPTED FILE"));
    assert_eq!(
        fs::read_to_string(root.join(format!(".clepsydra/crypto/{KEY_ID}.identity.age"))).unwrap(),
        ARMOR
    );
}

#[test]
fn setup_without_wrapped_identity_round_trips_as_public_only() {
    let (_tmp, root) = root();

    let created = setup_keyring(&root, KEY_ID, &recipient(), None).unwrap();

    assert!(created.wrapped_identity.is_none());
    assert!(created.keyring.keys[0].wrapped_identity_file.is_none());
    assert!(
        !root
            .join(format!(".clepsydra/crypto/{KEY_ID}.identity.age"))
            .exists()
    );
    assert_eq!(load_keyring(&root).unwrap().unwrap(), created);
}

#[test]
fn duplicate_setup_is_a_conflict_and_preserves_existing_files() {
    let (_tmp, root) = root();
    setup_keyring(&root, KEY_ID, &recipient(), Some(ARMOR)).unwrap();
    let metadata_path = root.join(".clepsydra/crypto/keyring.toml");
    let identity_path = root.join(format!(".clepsydra/crypto/{KEY_ID}.identity.age"));
    let metadata_before = fs::read(&metadata_path).unwrap();
    let identity_before = fs::read(&identity_path).unwrap();

    let error = setup_keyring(
        &root,
        "019fd000-0000-7000-8000-000000000502",
        &recipient(),
        Some(&armor_variant(b"different")),
    )
    .unwrap_err();

    assert!(matches!(error, KeyringError::AlreadyInitialized));
    assert_eq!(fs::read(metadata_path).unwrap(), metadata_before);
    assert_eq!(fs::read(identity_path).unwrap(), identity_before);
}

#[test]
fn setup_rejects_invalid_key_ids_recipients_and_control_characters() {
    for key_id in ["", "../escape", "019fd000-0000-7000-8000-000000000501\n"] {
        let (_tmp, root) = root();
        assert!(setup_keyring(&root, key_id, &recipient(), None).is_err());
        assert!(!root.join(".clepsydra/crypto/keyring.toml").exists());
    }

    for recipient in [
        "",
        "not-an-age-recipient",
        "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n",
        "age1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
    ] {
        let (_tmp, root) = root();
        assert!(setup_keyring(&root, KEY_ID, recipient, None).is_err());
        assert!(!root.join(".clepsydra/crypto/keyring.toml").exists());
    }
}

#[test]
fn invalid_wrapped_identity_is_rejected_without_echoing_armor() {
    let (_tmp, root) = root();
    let secret = "SENSITIVE_WRAPPED_IDENTITY_BYTES";
    let invalid =
        format!("-----BEGIN AGE ENCRYPTED FILE-----\n{secret}\n-----END AGE ENCRYPTED FILE-----\n");

    let error = setup_keyring(&root, KEY_ID, &recipient(), Some(&invalid)).unwrap_err();
    let message = error.to_string();

    assert!(matches!(error, KeyringError::InvalidWrappedIdentity));
    assert!(!message.contains(secret));
    assert!(!message.contains(&invalid));
    assert!(!root.join(".clepsydra/crypto/keyring.toml").exists());
    assert!(
        !root
            .join(format!(".clepsydra/crypto/{KEY_ID}.identity.age"))
            .exists()
    );
}

#[test]
fn rewrap_uses_optimistic_revision_and_atomically_replaces_identity() {
    let (_tmp, root) = root();
    let created = setup_keyring(&root, KEY_ID, &recipient(), Some(ARMOR)).unwrap();
    let identity_path = root.join(format!(".clepsydra/crypto/{KEY_ID}.identity.age"));
    let metadata_path = root.join(".clepsydra/crypto/keyring.toml");
    let metadata_before = fs::read(&metadata_path).unwrap();
    let identity_before = fs::read(&identity_path).unwrap();
    let replacement = armor_variant(b"rewrapped identity");

    let error = rewrap_identity(&root, &"0".repeat(64), Some(&replacement)).unwrap_err();
    match error {
        KeyringError::RevisionConflict { current_revision } => {
            assert_eq!(current_revision, created.revision)
        }
        other => panic!("expected revision conflict, got {other:?}"),
    }
    assert_eq!(fs::read(&metadata_path).unwrap(), metadata_before);
    assert_eq!(fs::read(&identity_path).unwrap(), identity_before);

    let replaced = rewrap_identity(&root, &created.revision, Some(&replacement)).unwrap();
    assert_ne!(replaced.revision, created.revision);
    assert_eq!(
        replaced.wrapped_identity.as_deref(),
        Some(replacement.as_str())
    );
    assert_eq!(fs::read(&metadata_path).unwrap(), metadata_before);
    assert_eq!(fs::read_to_string(&identity_path).unwrap(), replacement);
    assert_eq!(load_keyring(&root).unwrap().unwrap(), replaced);

    let unexpected_files = fs::read_dir(root.join(".clepsydra/crypto"))
        .unwrap()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name != "keyring.toml" && name != format!("{KEY_ID}.identity.age")
        })
        .collect::<Vec<_>>();
    assert!(unexpected_files.is_empty());
}

#[cfg(unix)]
#[test]
fn keyring_files_are_owner_only_and_rewrap_preserves_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let (_tmp, root) = root();
    let created = setup_keyring(&root, KEY_ID, &recipient(), Some(ARMOR)).unwrap();
    let crypto_dir = root.join(".clepsydra/crypto");
    let metadata_path = crypto_dir.join("keyring.toml");
    let identity_path = crypto_dir.join(format!("{KEY_ID}.identity.age"));

    assert_eq!(
        fs::metadata(&crypto_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&metadata_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&identity_path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    rewrap_identity(
        &root,
        &created.revision,
        Some(&armor_variant(b"new wrapping")),
    )
    .unwrap();
    assert_eq!(
        fs::metadata(&identity_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
