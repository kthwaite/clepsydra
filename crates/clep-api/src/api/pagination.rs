use serde::{Deserialize, Serialize};
use utoipa::IntoParams;

/// Query parameters for paginated list endpoints.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PaginationParams {
    /// Optional limit on the number of items to return. If not specified, all items will be returned.
    pub limit: Option<u32>,
    /// Optional offset to start returning items from. If not specified, defaults to 0.
    pub offset: Option<u32>,
}

/// Paginated response wrapper.
#[derive(Debug, Serialize)]
pub struct PaginatedResponse<T: Serialize> {
    /// The items in the current page.
    pub items: Vec<T>,
    /// The total number of items available.
    pub total: u32,
    /// The limit used for this page.
    pub limit: Option<u32>,
    /// The offset used for this page.
    pub offset: u32,
}

impl<T: Serialize> PaginatedResponse<T> {
    /// Create a new `PaginatedResponse` from a vector of items and pagination parameters.
    pub fn from_vec(items: Vec<T>, params: &PaginationParams) -> Self {
        let total = items.len() as u32;
        let offset = params.offset.unwrap_or(0);
        let start = offset as usize;

        let paged: Vec<T> = if let Some(limit) = params.limit {
            items.into_iter().skip(start).take(limit as usize).collect()
        } else {
            items.into_iter().skip(start).collect()
        };

        Self {
            items: paged,
            total,
            limit: params.limit,
            offset,
        }
    }
}
