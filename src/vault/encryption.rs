use base64::prelude::{BASE64_STANDARD, Engine as _};
use thiserror::Error;

const BEGIN_FENCE: &str = "-----BEGIN AGE ENCRYPTED FILE-----";
const END_FENCE: &str = "-----END AGE ENCRYPTED FILE-----";
const END_FENCE_LINE: &str = "-----END AGE ENCRYPTED FILE-----\n";
const AGE_HEADER: &[u8] = b"age-encryption.org/v1\n";
const ARMOR_LINE_WIDTH: usize = 64;

/// Maximum size of an armored encrypted note body accepted by the vault.
pub const MAX_AGE_ARMOR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncryptionFormat {
    Age,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EncryptionMeta {
    pub format: EncryptionFormat,
    pub version: u8,
    pub key_id: String,
}

impl EncryptionMeta {
    pub fn validate(&self) -> Result<(), EncryptionError> {
        if self.version != 1 {
            return Err(EncryptionError::UnsupportedVersion);
        }
        if self.key_id.trim().is_empty() {
            return Err(EncryptionError::EmptyKeyId);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum EncryptionError {
    #[error("encrypted body exceeds the maximum accepted size")]
    BodyTooLarge,
    #[error("encrypted body is not one canonical age armor block")]
    InvalidArmor,
    #[error("encrypted body payload is not canonical Base64")]
    InvalidBase64,
    #[error("encrypted body payload is not an age v1 file")]
    InvalidAgeHeader,
    #[error("unsupported encryption metadata version")]
    UnsupportedVersion,
    #[error("encryption key ID must not be empty")]
    EmptyKeyId,
}

pub fn validate_age_armor(body: &str) -> Result<(), EncryptionError> {
    if body.contains('\r') {
        return Err(EncryptionError::InvalidArmor);
    }
    let canonical = canonicalize_age_armor_inner(body, false)?;
    if canonical != body {
        return Err(EncryptionError::InvalidArmor);
    }
    Ok(())
}

pub fn canonicalize_age_armor(body: &str) -> Result<String, EncryptionError> {
    canonicalize_age_armor_inner(body, true)
}

fn canonicalize_age_armor_inner(
    body: &str,
    normalize_crlf: bool,
) -> Result<String, EncryptionError> {
    if body.len() > MAX_AGE_ARMOR_BYTES {
        return Err(EncryptionError::BodyTooLarge);
    }

    let normalized;
    let body = if normalize_crlf && body.contains('\r') {
        normalized = body.replace("\r\n", "\n");
        if normalized.contains('\r') {
            return Err(EncryptionError::InvalidArmor);
        }
        normalized.as_str()
    } else {
        body
    };

    let payload_start = BEGIN_FENCE.len() + 1;
    let payload_end = body
        .len()
        .checked_sub(END_FENCE.len() + 2)
        .ok_or(EncryptionError::InvalidArmor)?;
    if !body.starts_with(BEGIN_FENCE)
        || body.as_bytes().get(BEGIN_FENCE.len()) != Some(&b'\n')
        || payload_end < payload_start
        || body.as_bytes().get(payload_end) != Some(&b'\n')
        || body.get(payload_end + 1..) != Some(END_FENCE_LINE)
    {
        return Err(EncryptionError::InvalidArmor);
    }

    let payload = body
        .get(payload_start..payload_end)
        .ok_or(EncryptionError::InvalidArmor)?;
    let lines = payload.split('\n').collect::<Vec<_>>();
    if lines.is_empty()
        || lines.iter().any(|line| line.is_empty())
        || lines
            .iter()
            .take(lines.len().saturating_sub(1))
            .any(|line| line.len() != ARMOR_LINE_WIDTH)
        || lines
            .last()
            .is_some_and(|line| line.len() > ARMOR_LINE_WIDTH)
    {
        return Err(EncryptionError::InvalidArmor);
    }

    let encoded = lines.concat();
    let decoded = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| EncryptionError::InvalidBase64)?;
    if BASE64_STANDARD.encode(&decoded) != encoded {
        return Err(EncryptionError::InvalidBase64);
    }
    if !decoded.starts_with(AGE_HEADER) {
        return Err(EncryptionError::InvalidAgeHeader);
    }

    let payload = encoded
        .as_bytes()
        .chunks(ARMOR_LINE_WIDTH)
        .map(|line| std::str::from_utf8(line).expect("Base64 is ASCII"))
        .collect::<Vec<_>>()
        .join("\n");
    let canonical = format!("{BEGIN_FENCE}\n{payload}\n{END_FENCE}\n");
    if canonical.len() > MAX_AGE_ARMOR_BYTES {
        return Err(EncryptionError::BodyTooLarge);
    }
    Ok(canonical)
}
