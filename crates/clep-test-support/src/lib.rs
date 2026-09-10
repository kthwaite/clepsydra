//! Test-only helpers shared by every crate's test suite. Dev-dependency only.

/// An age-armored encrypted note, used as a fixture by encryption and
/// keyring tests across the workspace.
pub const PRIVATE_NOTE_AGE: &str = include_str!("../fixtures/private-note.age");

/// RAII guard that records the prior value of an env var on construction
/// and restores it on drop, so `#[serial]` tests can't leak state.
pub struct EnvGuard {
    key: &'static str,
    prior: Option<std::ffi::OsString>,
}

impl EnvGuard {
    pub fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let prior = std::env::var_os(key);
        // SAFETY: tests touching env are gated behind `#[serial_test::serial]`
        // so no other thread is racing on the same variable.
        unsafe { std::env::set_var(key, value) }
        Self { key, prior }
    }

    /// Unset `key` for as long as the guard lives.
    pub fn remove(key: &'static str) -> Self {
        let prior = std::env::var_os(key);
        // SAFETY: see `set`.
        unsafe { std::env::remove_var(key) }
        Self { key, prior }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        // SAFETY: see `set`.
        unsafe {
            match self.prior.take() {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EnvGuard;

    #[test]
    fn guard_restores_prior_value_on_drop() {
        let key = "CLEP_TEST_SUPPORT_PROBE";
        // SAFETY: single-threaded test, unique key.
        unsafe { std::env::set_var(key, "before") };
        {
            let _g = EnvGuard::set(key, "during");
            assert_eq!(std::env::var(key).unwrap(), "during");
        }
        assert_eq!(std::env::var(key).unwrap(), "before");
        {
            let _g = EnvGuard::remove(key);
            assert!(std::env::var_os(key).is_none());
        }
        assert_eq!(std::env::var(key).unwrap(), "before");
        unsafe { std::env::remove_var(key) };
    }
}
