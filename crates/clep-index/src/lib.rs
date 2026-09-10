//! The SQLite index, derivation chain, hooks traits, and filesystem sync over a
//! `clep_vault::Vault`.

pub mod derivation;
pub mod derivers;
pub mod grep;
pub mod hooks;
pub mod index;
pub mod index_handle;
pub mod index_policy;
pub mod reference_issues;
mod search;
pub mod sync;
pub mod tree;
