use base64::prelude::{BASE64_STANDARD, Engine as _};
use clepsydra::vault::encryption::{
    EncryptionFormat, EncryptionMeta, canonicalize_age_armor, validate_age_armor,
};

const BEGIN_FENCE: &str = "-----BEGIN AGE ENCRYPTED FILE-----";
const END_FENCE: &str = "-----END AGE ENCRYPTED FILE-----";
const AGE_HEADER: &[u8] = b"age-encryption.org/v1\n";
const MAX_AGE_ARMOR_BYTES: usize = 2 * 1024 * 1024;

fn armor(decoded: &[u8]) -> String {
    let encoded = BASE64_STANDARD.encode(decoded);
    let payload = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    format!("{BEGIN_FENCE}\n{payload}\n{END_FENCE}\n")
}

fn age_payload_with_len(len: usize) -> Vec<u8> {
    assert!(len >= AGE_HEADER.len());
    let mut decoded = vec![b'x'; len];
    decoded[..AGE_HEADER.len()].copy_from_slice(AGE_HEADER);
    decoded
}

#[test]
fn accepts_one_canonical_age_block() {
    let armor = include_str!("support/fixtures/private-note.age");
    validate_age_armor(armor).expect("valid age armor");
}

#[test]
fn rejects_missing_or_extra_fences() {
    let valid = include_str!("support/fixtures/private-note.age");
    let missing_begin = valid.replacen(BEGIN_FENCE, "", 1);
    let missing_end = valid.replacen(END_FENCE, "", 1);
    let extra = format!("{valid}{valid}");

    assert!(validate_age_armor(&missing_begin).is_err());
    assert!(validate_age_armor(&missing_end).is_err());
    assert!(validate_age_armor(&extra).is_err());
}

#[test]
fn rejects_prefix_or_suffix_text() {
    let valid = include_str!("support/fixtures/private-note.age");

    assert!(validate_age_armor(&format!("comment\n{valid}")).is_err());
    assert!(validate_age_armor(&format!("{valid}comment\n")).is_err());
    assert!(validate_age_armor(&format!("{valid}\n")).is_err());
}

#[test]
fn rejects_empty_payload() {
    let empty = format!("{BEGIN_FENCE}\n{END_FENCE}\n");
    assert!(validate_age_armor(&empty).is_err());
}

#[test]
fn rejects_invalid_base64() {
    let invalid = format!("{BEGIN_FENCE}\nnot@base64!\n{END_FENCE}\n");
    assert!(validate_age_armor(&invalid).is_err());
}

#[test]
fn rejects_decoded_data_without_age_header() {
    let not_age = armor(b"definitely-not-an-age-file\n");
    assert!(validate_age_armor(&not_age).is_err());
}

#[test]
fn rejects_noncanonical_line_wrapping_and_trailing_newline() {
    let valid = include_str!("support/fixtures/private-note.age");
    let payload = valid
        .strip_prefix(&format!("{BEGIN_FENCE}\n"))
        .unwrap()
        .strip_suffix(&format!("\n{END_FENCE}\n"))
        .unwrap();
    let split_payload = format!("{}\n{}", &payload[..8], &payload[8..]);
    let noncanonical = format!("{BEGIN_FENCE}\n{split_payload}\n{END_FENCE}\n");

    assert!(validate_age_armor(&noncanonical).is_err());
    assert!(validate_age_armor(valid.trim_end_matches('\n')).is_err());
}

#[test]
fn canonicalizer_normalizes_crlf_but_validator_requires_lf() {
    let valid = include_str!("support/fixtures/private-note.age");
    let crlf = valid.replace('\n', "\r\n");

    assert!(validate_age_armor(&crlf).is_err());
    assert_eq!(canonicalize_age_armor(&crlf).unwrap(), valid);
}

#[test]
fn rejects_lone_carriage_returns() {
    let valid = include_str!("support/fixtures/private-note.age");
    let with_lone_cr = valid.replacen('\n', "\r", 1);
    assert!(canonicalize_age_armor(&with_lone_cr).is_err());
}

#[test]
fn enforces_maximum_armored_body_size() {
    let mut low = AGE_HEADER.len();
    let mut high = MAX_AGE_ARMOR_BYTES;
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if armor(&age_payload_with_len(mid)).len() <= MAX_AGE_ARMOR_BYTES {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    let largest = armor(&age_payload_with_len(low));
    let oversized = armor(&age_payload_with_len(low + 1));
    assert!(largest.len() <= MAX_AGE_ARMOR_BYTES);
    assert!(oversized.len() > MAX_AGE_ARMOR_BYTES);
    validate_age_armor(&largest).expect("largest in-bounds armor should validate");
    assert!(validate_age_armor(&oversized).is_err());
}

#[test]
fn rejects_plaintext_without_echoing_it() {
    let secret = "do-not-repeat-this-secret";
    let error = validate_age_armor(secret).unwrap_err().to_string();
    assert!(!error.contains(secret));
}

#[test]
fn validation_errors_do_not_echo_invalid_armor() {
    let secret = "sensitive-invalid-payload";
    let invalid = format!("{BEGIN_FENCE}\n{secret}\n{END_FENCE}\n");
    let error = validate_age_armor(&invalid).unwrap_err().to_string();
    assert!(!error.contains(secret));
    assert!(!error.contains(&invalid));
}

#[test]
fn encryption_meta_supports_only_age_v1() {
    let meta = EncryptionMeta {
        format: EncryptionFormat::Age,
        version: 1,
        key_id: "019fd000-0000-7000-8000-000000000002".into(),
    };
    meta.validate().unwrap();

    let unsupported = EncryptionMeta {
        version: 2,
        ..meta.clone()
    };
    assert!(unsupported.validate().is_err());

    let empty_key = EncryptionMeta {
        key_id: " \t".into(),
        ..meta
    };
    assert!(empty_key.validate().is_err());
}
