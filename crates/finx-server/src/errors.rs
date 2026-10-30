//! Application errors shared by both protocols (codes in `finx_protocol::api::error_code`).

use finx_core::KernelError;
use finx_core::runtime::RuntimeError;
use finx_core::store::StoreError;
use finx_protocol::ErrorInfo;
use finx_protocol::api::error_code;
use finx_rpc::RpcError;

pub fn session_not_found(id: &str) -> RpcError {
    RpcError::with_kind(error_code::SESSION_NOT_FOUND, "session_not_found", format!("session {id} not found"))
}

pub fn not_initialized() -> RpcError {
    RpcError::with_kind(error_code::NOT_INITIALIZED, "not_initialized", "send initialize first")
}

pub fn session_busy(message: impl Into<String>) -> RpcError {
    RpcError::with_kind(error_code::SESSION_BUSY, "session_busy", message)
}

pub fn session_not_loaded(id: &str) -> RpcError {
    RpcError::with_kind(
        error_code::SESSION_NOT_LOADED,
        "session_not_loaded",
        format!("session {id} is not loaded; resume it first"),
    )
}

pub fn not_attached(id: &str) -> RpcError {
    RpcError::with_kind(
        error_code::NOT_ATTACHED,
        "not_attached",
        format!("attach to session {id} before sending operations"),
    )
}

pub fn prompt_in_progress(id: &str) -> RpcError {
    RpcError::with_kind(
        error_code::PROMPT_IN_PROGRESS,
        "prompt_in_progress",
        format!("session {id} is still working on the previous prompt"),
    )
}

pub fn approval_not_pending(call_id: &str) -> RpcError {
    RpcError::with_kind(
        error_code::APPROVAL_NOT_PENDING,
        "approval_not_pending",
        format!("no approval is pending for call {call_id}"),
    )
}

pub fn server_full(max: usize) -> RpcError {
    RpcError::with_kind(
        error_code::SERVER_FULL,
        "server_full",
        format!("the server has {max} sessions loaded and every one is in use"),
    )
}

pub fn overloaded() -> RpcError {
    RpcError::with_kind(error_code::OVERLOADED, "overloaded", "the session is busy; retry shortly")
}

pub fn unsupported_content(message: impl Into<String>) -> RpcError {
    RpcError::with_kind(error_code::UNSUPPORTED_CONTENT, "unsupported_content", message)
}

pub fn session_closed(id: &str) -> RpcError {
    RpcError::with_kind(error_code::SESSION_CLOSED, "session_closed", format!("session {id} is closed"))
}

/// A failed task, with the full error info in `data`.
pub fn task_failed(error: &ErrorInfo) -> RpcError {
    let mut data = serde_json::to_value(error).unwrap_or_default();
    if let Some(map) = data.as_object_mut() {
        map.insert("error_kind".into(), map.get("kind").cloned().unwrap_or_default());
        map.insert("kind".into(), "task_failed".into());
    }
    RpcError {
        code: error_code::TASK_FAILED,
        message: error.message.clone(),
        data: Some(data),
    }
}

pub fn from_store(err: StoreError, id: &str) -> RpcError {
    match err {
        StoreError::NotFound(_) => session_not_found(id),
        StoreError::Locked(_) => session_busy(format!("session {id} is open in another finx process")),
        StoreError::Ambiguous(message) => RpcError::invalid_params(message),
        other => RpcError::internal(other.to_string()),
    }
}

pub fn from_kernel(err: KernelError, id: &str) -> RpcError {
    match err {
        KernelError::Store(err) => from_store(err, id),
        KernelError::Model(err) => RpcError::invalid_params(err),
        KernelError::Other(message) => RpcError::internal(message),
    }
}

pub fn from_runtime(err: RuntimeError) -> RpcError {
    match err {
        RuntimeError::Cwd { .. } | RuntimeError::Config(_) => RpcError::invalid_params(err),
        other => RpcError::internal(other.to_string()),
    }
}
