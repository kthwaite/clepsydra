use serde::{Deserialize, Serialize};

/// Query parameters for paginated list endpoints.
#[derive(Debug, Deserialize)]
pub struct PaginationParams {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Paginated response wrapper.
#[derive(Debug, Serialize)]
pub struct PaginatedResponse<T: Serialize> {
    pub items: Vec<T>,
    pub total: u32,
    pub limit: Option<u32>,
    pub offset: u32,
}

impl<T: Serialize> PaginatedResponse<T> {
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
