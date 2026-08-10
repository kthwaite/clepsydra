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
use crate::vault::query::{QueryContext, QueryOutput, QueryRow, QuerySpec, evaluate};

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
    let spec = QuerySpec {
        filter: request.filter,
        sort: request.sort,
        group_by: request.group_by,
        aggregates: request.aggregates,
        columns: request.columns,
        limit: request.limit,
        offset: request.offset,
        group_row_limit: request.group_row_limit,
    };
    let types = request.types;

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
