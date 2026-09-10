pub use clep_vault::Vault;
pub use clep_vault::{
    atomic_file, attendance, bcl, block, block_id, board_vocab, canonical, code, config, conflict,
    context, conversation, encryption, init, keyring, kind, legacy_yaml, link, location, markdown,
    meeting, page, page_filename, path, project, projection, rewriter, rubbish, task_history,
    toml_json, toml_patch,
};

pub mod geocode;
pub use clep_gitsync as gitsync;

pub use clep_academic::{
    academic, academic_hook, checkpoint, import, import_doi, import_isbn, import_zotero,
};

pub use clep_archive::{
    archive_backfill, archive_hook, archive_snapshot, cas, cas_migrate, cas_scan,
};

pub use clep_mutate::{
    batch_mutation, migrate, mutation, mutation_coordinator, new_note, recode, reconcile,
    reference_repair, relabel,
};

pub use clep_index::{
    derivation, derivers, grep, hooks, index, index_handle, index_policy, reference_issues, sync,
    tree,
};

pub use clep_bases::{base, base_document, base_embed, base_member, property_value, query};
