pub use clep_vault::Vault;
pub use clep_vault::{
    atomic_file, attendance, bcl, block, block_id, board_vocab, canonical, code, config, conflict,
    context, conversation, encryption, init, keyring, kind, legacy_yaml, link, location, markdown,
    meeting, page, page_filename, path, project, projection, rewriter, rubbish, task_history,
    toml_json, toml_patch,
};

pub mod academic;
pub mod academic_hook;
pub mod archive_backfill;
pub mod archive_hook;
pub mod archive_snapshot;
pub mod base;
pub mod base_document;
pub mod base_embed;
pub mod base_member;
pub mod batch_mutation;
pub mod cas;
pub mod cas_migrate;
pub mod cas_scan;
pub mod checkpoint;
pub mod geocode;
pub mod gitsync;
pub mod import;
pub mod import_doi;
pub mod import_isbn;
pub mod import_zotero;
pub mod migrate;
pub mod mutation;
pub mod mutation_coordinator;
pub mod new_note;
pub mod property_value;
pub mod query;
pub mod recode;
pub mod reconcile;
pub mod reference_repair;
pub mod relabel;

pub use clep_index::{
    derivation, derivers, grep, hooks, index, index_handle, index_policy, reference_issues, sync,
    tree,
};
