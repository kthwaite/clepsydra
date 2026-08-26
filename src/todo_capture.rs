//! Reusable Todo rendering and capture through the configured local server.

use std::error::Error;

use chrono::NaiveDate;
use thiserror::Error;

use crate::mcp::client::{ApiCallError, ApiClient};
use crate::mcp::configured_api_client;

const CAPTURE_ENDPOINT: &str = "/api/vault/journal/today/capture";

/// Text and optional inline properties for one unchecked Markdown Todo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoCaptureInput {
    pub text: String,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub priority: Option<String>,
}

/// A Todo could not be rendered or captured.
#[derive(Debug, Error)]
pub enum TodoCaptureError {
    #[error("todo text must contain at least one non-whitespace character")]
    BlankText,
    #[error("invalid {field} date \"{value}\": expected a real date in exact YYYY-MM-DD format")]
    InvalidDate { field: &'static str, value: String },
    #[error("invalid priority \"{0}\": expected A, B, or C")]
    InvalidPriority(String),
    #[error("failed to connect to the configured local clepsydra server: {0}")]
    ClientSetup(#[source] Box<dyn Error>),
    #[error(transparent)]
    Api(#[from] ApiCallError),
    #[error(
        "capture succeeded, but the server response did not include a journal path; \
         check that the running clepsydra server supports the journal capture API"
    )]
    MissingPath,
}

/// Normalize, validate, and render one unchecked Markdown Todo.
pub fn render_todo(input: &TodoCaptureInput) -> Result<String, TodoCaptureError> {
    let text = input.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(TodoCaptureError::BlankText);
    }

    validate_optional_date("due", input.due.as_deref())?;
    validate_optional_date("scheduled", input.scheduled.as_deref())?;
    if let Some(priority) = input.priority.as_deref()
        && !matches!(priority, "A" | "B" | "C")
    {
        return Err(TodoCaptureError::InvalidPriority(priority.to_string()));
    }

    let mut rendered = format!("- [ ] {text}");
    if let Some(due) = input.due.as_deref() {
        rendered.push_str(&format!(" [due:: {due}]"));
    }
    if let Some(scheduled) = input.scheduled.as_deref() {
        rendered.push_str(&format!(" [scheduled:: {scheduled}]"));
    }
    if let Some(priority) = input.priority.as_deref() {
        rendered.push_str(&format!(" [priority:: {priority}]"));
    }
    Ok(rendered)
}

/// Capture one Todo into today's journal through the configured local server.
pub async fn capture_todo(input: TodoCaptureInput) -> Result<String, TodoCaptureError> {
    let cwd =
        std::env::current_dir().map_err(|error| TodoCaptureError::ClientSetup(Box::new(error)))?;
    let client = configured_api_client(&cwd, false).map_err(TodoCaptureError::ClientSetup)?;
    capture_todo_with_client(&client, input).await
}

async fn capture_todo_with_client(
    client: &ApiClient,
    input: TodoCaptureInput,
) -> Result<String, TodoCaptureError> {
    let content = render_todo(&input)?;
    let response = client
        .post_json(CAPTURE_ENDPOINT, &serde_json::json!({ "content": content }))
        .await?;
    response
        .get("path")
        .and_then(serde_json::Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string)
        .ok_or(TodoCaptureError::MissingPath)
}

fn validate_optional_date(
    field: &'static str,
    value: Option<&str>,
) -> Result<(), TodoCaptureError> {
    let Some(value) = value else {
        return Ok(());
    };
    let bytes = value.as_bytes();
    let exact_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    if !exact_shape || NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err() {
        return Err(TodoCaptureError::InvalidDate {
            field,
            value: value.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::client::ApiClient;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn input(text: &str) -> TodoCaptureInput {
        TodoCaptureInput {
            text: text.to_string(),
            due: None,
            scheduled: None,
            priority: None,
        }
    }

    #[test]
    fn renders_normalized_text_and_properties_in_canonical_order() {
        let mut todo = input("  Review\n\t the   proposal  ");
        todo.due = Some("2026-08-31".to_string());
        todo.scheduled = Some("2026-08-27".to_string());
        todo.priority = Some("B".to_string());

        assert_eq!(
            render_todo(&todo).unwrap(),
            "- [ ] Review the proposal [due:: 2026-08-31] [scheduled:: 2026-08-27] [priority:: B]"
        );
    }

    #[test]
    fn rejects_blank_text() {
        let error = render_todo(&input(" \n\t ")).unwrap_err();
        assert!(matches!(error, TodoCaptureError::BlankText));
        assert!(error.to_string().contains("todo text"));
    }

    #[test]
    fn rejects_malformed_or_nonexistent_due_dates() {
        for due in ["2026-8-27", "2026-02-29", "not-a-date"] {
            let mut todo = input("Review proposal");
            todo.due = Some(due.to_string());

            let error = render_todo(&todo).unwrap_err();
            assert!(
                matches!(
                    error,
                    TodoCaptureError::InvalidDate { field: "due", .. }
                ),
                "unexpected error for {due}: {error}"
            );
        }
    }

    #[test]
    fn rejects_malformed_or_nonexistent_scheduled_dates() {
        for scheduled in ["2026-08-7", "2026-04-31"] {
            let mut todo = input("Review proposal");
            todo.scheduled = Some(scheduled.to_string());

            let error = render_todo(&todo).unwrap_err();
            assert!(
                matches!(
                    error,
                    TodoCaptureError::InvalidDate {
                        field: "scheduled",
                        ..
                    }
                ),
                "unexpected error for {scheduled}: {error}"
            );
        }
    }

    #[test]
    fn accepts_only_a_b_or_c_priority() {
        for priority in ["A", "B", "C"] {
            let mut todo = input("Review proposal");
            todo.priority = Some(priority.to_string());
            assert!(render_todo(&todo).is_ok(), "priority {priority} should pass");
        }

        for priority in ["a", "P1", "D", ""] {
            let mut todo = input("Review proposal");
            todo.priority = Some(priority.to_string());
            let error = render_todo(&todo).unwrap_err();
            assert!(matches!(error, TodoCaptureError::InvalidPriority(_)));
        }
    }

    #[tokio::test]
    async fn posts_rendered_todo_and_returns_journal_path() {
        let server = MockServer::start().await;
        let mut todo = input("  Review\nproposal ");
        todo.due = Some("2026-08-31".to_string());

        Mock::given(method("POST"))
            .and(path("/api/vault/journal/today/capture"))
            .and(body_json(serde_json::json!({
                "content": "- [ ] Review proposal [due:: 2026-08-31]"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "path": "journals/2026-08-26--abc.md"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = ApiClient::new(server.uri(), None).unwrap();
        let captured_path = capture_todo_with_client(&client, todo).await.unwrap();

        assert_eq!(captured_path, "journals/2026-08-26--abc.md");
    }

    #[tokio::test]
    async fn reports_api_failure_from_capture_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/vault/journal/today/capture"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "cannot capture into a protected journal page"
            })))
            .mount(&server)
            .await;

        let client = ApiClient::new(server.uri(), None).unwrap();
        let error = capture_todo_with_client(&client, input("Review proposal"))
            .await
            .unwrap_err();

        assert!(matches!(error, TodoCaptureError::Api(_)));
        assert!(
            error
                .to_string()
                .contains("cannot capture into a protected journal page")
        );
    }

    #[tokio::test]
    async fn reports_missing_path_in_success_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/vault/journal/today/capture"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "journal-id"
            })))
            .mount(&server)
            .await;

        let client = ApiClient::new(server.uri(), None).unwrap();
        let error = capture_todo_with_client(&client, input("Review proposal"))
            .await
            .unwrap_err();

        assert!(matches!(error, TodoCaptureError::MissingPath));
        assert!(error.to_string().contains("did not include a journal path"));
    }
}
