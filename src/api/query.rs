//! The generic query endpoint: the same evaluator as the view endpoint,
//! without a base context. An inline `types` map disambiguates property
//! types; unhinted properties compare as text.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::post;
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::base::{Aggregate, Filter, PropertyType, SortKey};
use crate::vault::query::{
    GroupRowLimit, QueryContext, QueryOutput, QueryRow, QuerySpec, evaluate,
};

#[derive(Debug, Deserialize, ToSchema)]
pub struct QueryRequest {
    #[serde(default)]
    pub filter: Option<Filter>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub aggregates: Vec<Aggregate>,
    #[serde(default)]
    pub columns: Vec<String>,
    /// Inline property-type hints (`{ "rating": "number" }`).
    #[serde(default)]
    pub types: HashMap<String, PropertyType>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub group_row_limit: Option<u32>,
}

/// Remove system-owned conversation ledger values from public query rows while
/// leaving index-side filtering, sorting, and grouping unchanged.
pub(crate) fn redact_conversation_columns(output: &mut QueryOutput) {
    fn redact_row(row: &mut QueryRow) {
        row.columns.remove("conversation");
    }
    match output {
        QueryOutput::Flat { rows, .. } => rows.iter_mut().for_each(redact_row),
        QueryOutput::Grouped { groups } => groups
            .iter_mut()
            .flat_map(|group| group.rows.iter_mut())
            .for_each(redact_row),
    }
}

impl QueryRequest {
    fn into_query_parts(self) -> (QuerySpec, HashMap<String, PropertyType>) {
        let Self {
            filter,
            sort,
            group_by,
            aggregates,
            columns,
            types,
            limit,
            offset,
            group_row_limit,
        } = self;
        let group_row_limit = match group_row_limit {
            Some(limit) => GroupRowLimit::Limit(limit),
            None => GroupRowLimit::Default,
        };

        (
            QuerySpec {
                filter,
                sort,
                group_by,
                aggregates,
                columns,
                limit,
                offset,
                group_row_limit,
            },
            types,
        )
    }
}

/// Evaluate an ad-hoc query over the whole vault.
#[utoipa::path(
    post,
    path = "",
    context_path = "/api/vault/query",
    tag = "Bases",
    request_body = QueryRequest,
    responses(
        (status = 200, body = QueryOutput),
        (status = 400, description = "Invalid filter, field, or value")
    )
)]
pub async fn run_query(
    State(state): State<Arc<AppState>>,
    Json(request): Json<QueryRequest>,
) -> Result<Json<QueryOutput>, ApiError> {
    let (spec, types) = request.into_query_parts();

    let mut output = state
        .index
        .with_index(move |index, _vault| {
            let ctx = QueryContext { base: None, types };
            evaluate(index.connection(), &spec, &ctx)
        })
        .await
        .map_err(|e| ApiError::internal(format!("index error: {e}")))?
        .map_err(|e| ApiError::bad_request(format!("query error: {e}")))?;
    redact_conversation_columns(&mut output);
    Ok(Json(output))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", post(run_query))
}

#[cfg(test)]
mod tests {
    use super::QueryRequest;
    use crate::vault::query::GroupRowLimit;

    #[test]
    fn generic_query_absent_group_limit_maps_to_default() {
        let request: QueryRequest = serde_json::from_value(serde_json::json!({})).unwrap();

        let (spec, _types) = request.into_query_parts();

        assert_eq!(spec.group_row_limit, GroupRowLimit::Default);
    }

    #[test]
    fn generic_query_explicit_group_limit_maps_to_explicit_cap() {
        let request: QueryRequest =
            serde_json::from_value(serde_json::json!({ "group_row_limit": 7 })).unwrap();

        let (spec, _types) = request.into_query_parts();

        assert_eq!(spec.group_row_limit, GroupRowLimit::Limit(7));
    }
}
