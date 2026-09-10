//! Mutation planning, coordination, and repair over a `clep_vault::Vault` and
//! its `clep_index` index: batched writes, reconciliation, and reference,
//! label, and code repair.

pub mod batch_mutation;
pub mod migrate;
pub mod mutation;
pub mod mutation_coordinator;
pub mod new_note;
pub mod recode;
pub mod reconcile;
pub mod reference_repair;
pub mod relabel;
