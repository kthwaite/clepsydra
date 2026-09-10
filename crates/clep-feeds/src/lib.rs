//! Feed fetching, storage, and scheduling: RSS/Atom parsing and conditional
//! HTTP fetches, a SQLite-backed store with retention and snapshotting, and
//! the background sweep that keeps subscriptions up to date.

pub mod fetch;
pub mod manifest;
pub mod network;
pub mod runtime;
pub mod scheduler;
pub mod store;
pub mod types;
