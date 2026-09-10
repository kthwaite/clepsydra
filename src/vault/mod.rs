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

pub use clep_mutate::{
    batch_mutation, migrate, mutation, mutation_coordinator, new_note, recode, reconcile,
    reference_repair, relabel,
};

pub use clep_index::{
    derivation, derivers, grep, hooks, index, index_handle, index_policy, reference_issues, sync,
    tree,
};

pub use clep_bases::{base, base_document, base_embed, base_member, property_value, query};
