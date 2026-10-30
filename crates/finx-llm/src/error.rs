//! Error classification shared by all adapters.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Auth,
    QuotaExceeded,
    RateLimited,
    Overloaded,
    Server,
    Network,
    Timeout,
    ContextOverflow,
    InvalidRequest,
    ContentFiltered,
    Protocol,
    Unknown,
}

impl ErrorKind {
    /// Whether the registry may retry automatically (before any content arrived).
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            ErrorKind::RateLimited
                | ErrorKind::Overloaded
                | ErrorKind::Server
                | ErrorKind::Network
                | ErrorKind::Timeout
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Auth => "auth",
            ErrorKind::QuotaExceeded => "quota_exceeded",
            ErrorKind::RateLimited => "rate_limited",
            ErrorKind::Overloaded => "overloaded",
            ErrorKind::Server => "server",
            ErrorKind::Network => "network",
            ErrorKind::Timeout => "timeout",
            ErrorKind::ContextOverflow => "context_overflow",
            ErrorKind::InvalidRequest => "invalid_request",
            ErrorKind::ContentFiltered => "content_filtered",
            ErrorKind::Protocol => "protocol",
            ErrorKind::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error, JsonSchema)]
#[error("{kind}: {message}")]
pub struct LlmError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

const DEFAULT_OVERFLOW_PATTERNS: &[&str] = &[
    "context length",
    "context_length",
    "maximum context",
    "context window",
    "prompt is too long",
    "too many tokens",
    "input is too long",
    "reduce the length",
];

const QUOTA_PATTERNS: &[&str] = &[
    "insufficient balance",
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "billing",
    "balance",
    "arrears",
];

impl LlmError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            provider_code: None,
            retry_after_ms: None,
        }
    }

    /// Classify a non-2xx HTTP response.
    pub fn from_http(
        status: u16,
        body: &str,
        retry_after_ms: Option<u64>,
        overflow_patterns: &[String],
    ) -> Self {
        let parsed: Option<Value> = serde_json::from_str(body).ok();
        let (message, code) = parsed
            .as_ref()
            .map(extract_error_fields)
            .unwrap_or((None, None));
        let message = message.unwrap_or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                format!("HTTP {status}")
            } else {
                truncate_chars(trimmed, 500)
            }
        });
        let haystack = format!("{} {}", message, code.clone().unwrap_or_default()).to_lowercase();
        let kind = classify(status, &haystack, overflow_patterns);
        Self {
            kind,
            message,
            status: Some(status),
            provider_code: code,
            retry_after_ms,
        }
    }

    /// Classify an error object that arrived inside a stream.
    pub fn from_stream_error(error: &Value, overflow_patterns: &[String]) -> Self {
        let (message, code) = extract_error_fields(&serde_json::json!({ "error": error }));
        let message = message.unwrap_or_else(|| error.to_string());
        let haystack = format!("{} {}", message, code.clone().unwrap_or_default()).to_lowercase();
        let kind = if haystack.contains("connection_login_required")
            || haystack.contains("local_auth_invalid")
        {
            ErrorKind::Auth
        } else if haystack.contains("overloaded") {
            ErrorKind::Overloaded
        } else if haystack.contains("rate_limit") || haystack.contains("rate limit") {
            ErrorKind::RateLimited
        } else if matches_any(&haystack, DEFAULT_OVERFLOW_PATTERNS, overflow_patterns) {
            ErrorKind::ContextOverflow
        } else if haystack.contains("authentication") || haystack.contains("permission") {
            ErrorKind::Auth
        } else if haystack.contains("invalid_request") {
            ErrorKind::InvalidRequest
        } else if haystack.contains("api_error") || haystack.contains("server") {
            ErrorKind::Server
        } else {
            ErrorKind::Unknown
        };
        Self {
            kind,
            message,
            status: None,
            provider_code: code,
            retry_after_ms: None,
        }
    }

    /// The provider says the requested model does not exist (it may have been retired).
    pub fn is_missing_model(&self) -> bool {
        if !matches!(self.kind, ErrorKind::InvalidRequest | ErrorKind::Unknown) {
            return false;
        }
        let code = self.provider_code.as_deref().unwrap_or_default().to_lowercase();
        let message = self.message.to_lowercase();
        code.contains("model_not_found")
            || (message.contains("model")
                && ["not exist", "does not exist", "not found", "no such model", "unknown model"]
                    .iter()
                    .any(|p| message.contains(p)))
    }

    pub fn from_reqwest(err: &reqwest::Error) -> Self {
        let kind = if err.is_timeout() {
            ErrorKind::Timeout
        } else {
            ErrorKind::Network
        };
        let mut message = err.to_string();
        let mut source = std::error::Error::source(err);
        while let Some(inner) = source {
            message.push_str(": ");
            message.push_str(&inner.to_string());
            source = inner.source();
        }
        Self::new(kind, message)
    }
}

fn classify(status: u16, haystack: &str, overflow_patterns: &[String]) -> ErrorKind {
    if haystack.contains("connection_login_required")
        || haystack.contains("connection_permission_required")
    {
        return ErrorKind::Auth;
    }
    match status {
        401 | 403 => ErrorKind::Auth,
        402 => ErrorKind::QuotaExceeded,
        429 if QUOTA_PATTERNS.iter().any(|p| haystack.contains(p)) => ErrorKind::QuotaExceeded,
        429 => ErrorKind::RateLimited,
        503 | 529 => ErrorKind::Overloaded,
        500..=599 if haystack.contains("overloaded") => ErrorKind::Overloaded,
        500..=599 => ErrorKind::Server,
        400..=499 if matches_any(haystack, DEFAULT_OVERFLOW_PATTERNS, overflow_patterns) => {
            ErrorKind::ContextOverflow
        }
        400..=499 if haystack.contains("content_filter") || haystack.contains("content filter") => {
            ErrorKind::ContentFiltered
        }
        400..=499 => ErrorKind::InvalidRequest,
        _ => ErrorKind::Unknown,
    }
}

fn matches_any(haystack: &str, defaults: &[&str], extra: &[String]) -> bool {
    defaults.iter().any(|p| haystack.contains(p))
        || extra.iter().any(|p| haystack.contains(&p.to_lowercase()))
}

/// Pulls `(message, code)` out of the common error body shapes.
fn extract_error_fields(value: &Value) -> (Option<String>, Option<String>) {
    let err = value.get("error").unwrap_or(value);
    let message = err
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| err.as_str())
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(str::to_string);
    let code = err
        .get("code")
        .and_then(|c| match c {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .or_else(|| err.get("type").and_then(Value::as_str).map(str::to_string));
    (message, code)
}

pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_statuses() {
        let none: Vec<String> = Vec::new();
        assert_eq!(
            LlmError::from_http(401, "{}", None, &none).kind,
            ErrorKind::Auth
        );
        assert_eq!(
            LlmError::from_http(
                402,
                r#"{"error":{"message":"Insufficient Balance"}}"#,
                None,
                &none
            )
            .kind,
            ErrorKind::QuotaExceeded
        );
        assert_eq!(
            LlmError::from_http(429, "slow down", None, &none).kind,
            ErrorKind::RateLimited
        );
        assert_eq!(
            LlmError::from_http(529, "", None, &none).kind,
            ErrorKind::Overloaded
        );
        assert_eq!(
            LlmError::from_http(500, "", None, &none).kind,
            ErrorKind::Server
        );
        let overflow = LlmError::from_http(
            400,
            r#"{"error":{"message":"This model's maximum context length is 8192 tokens","code":"context_length_exceeded"}}"#,
            None,
            &none,
        );
        assert_eq!(overflow.kind, ErrorKind::ContextOverflow);
        assert_eq!(
            overflow.provider_code.as_deref(),
            Some("context_length_exceeded")
        );
        assert_eq!(
            LlmError::from_http(400, "bad", None, &none).kind,
            ErrorKind::InvalidRequest
        );
    }

    #[test]
    fn missing_models_are_recognized() {
        let gone = LlmError::from_http(400, r#"{"error":{"message":"Model Not Exist","code":"invalid_request_error"}}"#, None, &[]);
        assert!(gone.is_missing_model());
        let openai = LlmError::from_http(404, r#"{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}"#, None, &[]);
        assert!(openai.is_missing_model());
        assert!(!LlmError::from_http(400, r#"{"error":{"message":"bad tool schema"}}"#, None, &[]).is_missing_model());
        assert!(!LlmError::from_http(401, r#"{"error":{"message":"model not found"}}"#, None, &[]).is_missing_model());
    }

    #[test]
    fn custom_overflow_pattern() {
        let patterns = vec!["too much input".to_string()];
        let err = LlmError::from_http(400, "Too much input for this model", None, &patterns);
        assert_eq!(err.kind, ErrorKind::ContextOverflow);
    }
}
