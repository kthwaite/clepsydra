use rusqlite::Connection;
use thiserror::Error;

use super::index::SearchResult;

pub(super) mod query;
mod sql;

pub(crate) use query::{
    SearchDiagnostic, SearchDiagnosticKind, SearchQueryError, SearchSpan,
};

#[derive(Debug, Error)]
pub(super) enum SearchExecutionError {
    #[error(transparent)]
    Query(#[from] SearchQueryError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

pub(super) fn search(
    connection: &Connection,
    input: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, SearchExecutionError> {
    let expression = query::parse(input)?;
    sql::execute(connection, input, &expression, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_does_not_reclassify_sqlite_errors_as_query_errors() {
        let connection = Connection::open_in_memory().unwrap();

        assert!(matches!(
            search(&connection, "text", 10),
            Err(SearchExecutionError::Sqlite(_))
        ));
    }
}
