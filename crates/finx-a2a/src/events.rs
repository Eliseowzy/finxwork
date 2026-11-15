//! Turns the other side's A2A responses into [`PeerEvent`]s (docs/kernel/bot-contacts-design.md
//! §5.3, appendix B). One response at a time: a task, a status update, an artifact chunk, or a
//! whole message. The assembler holds the pieces until they are complete, because the owner sees
//! a finished sentence, not every token the other side sends.

use std::collections::BTreeMap;

use base64::Engine;
use bytes::Bytes;
use finx_core::PeerError;
use finx_core::PeerEvent;
use finx_core::PeerThread;
use serde_json::Value;

/// The largest file the other side may give (§5.3).
const FILE_MAX: u64 = 50 * 1024 * 1024;
/// What one round's files may add up to (§5.3).
const ROUND_MAX: u64 = 200 * 1024 * 1024;
/// The most text one artifact may collect: a chat reply is never this long, and the pieces are
/// held until the artifact is complete.
const TEXT_MAX: usize = 1024 * 1024;

/// What an artifact has collected so far.
#[derive(Debug, Default)]
struct Artifact {
    text: String,
    files: Vec<PendingFile>,
    name: Option<String>,
}

#[derive(Debug)]
struct PendingFile {
    name: String,
    media_type: Option<String>,
    bytes: Bytes,
}

/// How much the other side has already handed over this round, counted as the pieces arrive
/// (the kernel's own check would see a file only after it is all in memory).
#[derive(Debug, Default)]
struct Budget {
    bytes: u64,
    overflow: bool,
}

impl Budget {
    fn charge(&mut self, size: u64) -> bool {
        if size > FILE_MAX || self.bytes.saturating_add(size) > ROUND_MAX {
            self.overflow = true;
            return false;
        }
        self.bytes += size;
        true
    }
}

/// The A2A to [`PeerEvent`] state for one round.
#[derive(Debug, Default)]
pub struct Assembler {
    thread: PeerThread,
    /// The identifiers already given out; a change gives another `Thread`.
    announced: Option<PeerThread>,
    artifacts: BTreeMap<String, Artifact>,
    /// A `Said`, `File` or `Asked` went out: a round that ends without one is `no_reply`.
    saw_content: bool,
    /// An artifact gave text: the `status.message` of a completed task is then a duplicate.
    saw_artifact_text: bool,
    unnamed: u64,
    terminal: bool,
    budget: Budget,
    /// A group batch: no content is silence, not a failure, and `metadata.silent` is honoured.
    group: bool,
    /// The other side said this turn is silent (`metadata.silent`, brief §4.7).
    silent: bool,
}

impl Assembler {
    /// The assembler for a group batch: a rounded reply that says nothing is silence.
    pub fn group() -> Self {
        Self {
            group: true,
            ..Self::default()
        }
    }

    /// Applies one JSON-RPC response (an SSE `data:` payload or a whole JSON body).
    pub fn apply(&mut self, value: &Value) -> Vec<PeerEvent> {
        let mut out = Vec::new();
        if self.terminal {
            return out;
        }
        if let Some(error) = value.get("error") {
            out.push(PeerEvent::Failed(peer_error_from_error(error)));
            self.terminal = true;
            return out;
        }
        let result = value.get("result").unwrap_or(value);
        if let Some(task) = result.get("task") {
            self.apply_task(task, &mut out);
        } else if result.get("id").is_some() && result.get("status").is_some() {
            // `GetTask` and `CancelTask` answer with the task itself, not with `{ "task": … }`.
            self.apply_task(result, &mut out);
        } else if let Some(update) = result.get("statusUpdate") {
            self.apply_status_update(update, &mut out);
        } else if let Some(update) = result.get("artifactUpdate") {
            self.apply_artifact_update(update, &mut out);
        } else if let Some(message) = result.get("message") {
            self.apply_message(message, &mut out);
        } else if result.get("messageId").is_some() && result.get("parts").is_some() {
            self.apply_message(result, &mut out);
        }
        if self.budget.overflow {
            // It sent more than a round may hold: stop here rather than keep reading (§5.3).
            self.terminal = true;
            return vec![PeerEvent::Failed(PeerError::new(
                "bot_peer_too_large",
                "the other side sent more than this side keeps",
            ))];
        }
        if out.is_empty() {
            // An event that says nothing else still proves the connection is alive.
            out.push(PeerEvent::Working);
        }
        out
    }

    /// Ends the stream: whatever arrived in an artifact without `lastChunk` counts as complete.
    pub fn finish(&mut self) -> Vec<PeerEvent> {
        let mut out = Vec::new();
        if self.terminal {
            return out;
        }
        if self.group && self.silent {
            self.terminal = true;
            out.push(PeerEvent::Done);
            return out;
        }
        self.flush_artifacts(&mut out);
        if self.saw_content || self.group {
            out.push(PeerEvent::Done);
        } else {
            out.push(PeerEvent::Failed(no_reply()));
        }
        self.terminal = true;
        out
    }

    pub fn is_terminal(&self) -> bool {
        self.terminal
    }

    /// The conversation and task identifiers seen so far.
    pub fn thread(&self) -> &PeerThread {
        &self.thread
    }

    fn apply_task(&mut self, task: &Value, out: &mut Vec<PeerEvent>) {
        let before = out.len();
        self.update_thread(task, out);
        // A task that only announces the identifiers is already proof of life; `Working` is for
        // events that would otherwise say nothing.
        let had_thread = out.len() > before;
        if let Some(artifacts) = task.get("artifacts").and_then(Value::as_array) {
            // A task result carries a snapshot of each artifact, not chunks: the non-streaming
            // shape has all the parts of one artifact in a single array. It is held until the
            // task's state says it is complete, so a task that is still working when it is looked
            // at does not give a sentence the subscription will give again.
            for artifact in artifacts {
                let id = self.artifact_id(artifact);
                let mut buffer = Artifact {
                    name: name_of(artifact),
                    ..Default::default()
                };
                add_parts(&mut buffer, artifact, &mut self.budget);
                self.artifacts.insert(id, buffer);
            }
        }
        match task.get("status") {
            Some(status) => self.apply_status(status, out, had_thread),
            None if !had_thread => out.push(PeerEvent::Working),
            None => {}
        }
    }

    fn apply_status_update(&mut self, update: &Value, out: &mut Vec<PeerEvent>) {
        let before = out.len();
        self.update_thread(update, out);
        let had_thread = out.len() > before;
        match update.get("status") {
            Some(status) => self.apply_status(status, out, had_thread),
            None if !had_thread => out.push(PeerEvent::Working),
            None => {}
        }
    }

    fn apply_status(&mut self, status: &Value, out: &mut Vec<PeerEvent>, had_thread: bool) {
        let state = status
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match state {
            // Work in progress, with or without text: the text is not the reply.
            "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" if !had_thread => {
                out.push(PeerEvent::Working)
            }
            "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" => {}
            "TASK_STATE_COMPLETED" if self.group && self.silent => {
                out.push(PeerEvent::Done);
                self.terminal = true;
            }
            "TASK_STATE_COMPLETED" => {
                self.flush_artifacts(out);
                if !self.saw_artifact_text
                    && let Some(message) = status.get("message")
                {
                    self.add_message(message, out);
                }
                if self.saw_content || self.group {
                    out.push(PeerEvent::Done);
                } else {
                    out.push(PeerEvent::Failed(no_reply()));
                }
                self.terminal = true;
            }
            "TASK_STATE_FAILED" | "TASK_STATE_REJECTED" => {
                self.flush_artifacts(out);
                let text = message_text(status.get("message"), &mut self.budget);
                let message = if text.trim().is_empty() {
                    "the other side failed the task".to_string()
                } else {
                    text
                };
                out.push(PeerEvent::Failed(
                    PeerError::new("bot_peer_failed", message).retryable(),
                ));
                self.terminal = true;
            }
            "TASK_STATE_CANCELED" => {
                self.flush_artifacts(out);
                out.push(PeerEvent::Done);
                self.terminal = true;
            }
            "TASK_STATE_INPUT_REQUIRED" => {
                self.flush_artifacts(out);
                let message = status.get("message");
                let text = message_text(message, &mut self.budget);
                if let Some(message) = message {
                    let mut buffer = Artifact::default();
                    add_parts(&mut buffer, message, &mut self.budget);
                    for file in buffer.files {
                        self.saw_content = true;
                        out.push(file_event(file));
                    }
                }
                self.saw_content = true;
                out.push(PeerEvent::Asked { text });
                self.terminal = true;
            }
            "TASK_STATE_AUTH_REQUIRED" => {
                let text = message_text(status.get("message"), &mut self.budget);
                let message = if text.trim().is_empty() {
                    "the other side needs a credential again".to_string()
                } else {
                    text
                };
                out.push(PeerEvent::Failed(PeerError::auth_required(message)));
                self.terminal = true;
            }
            _ if !had_thread => out.push(PeerEvent::Working),
            _ => {}
        }
    }

    fn apply_artifact_update(&mut self, update: &Value, out: &mut Vec<PeerEvent>) {
        let before = out.len();
        self.update_thread(update, out);
        let had_thread = out.len() > before;
        if self.group && self.silent {
            if !had_thread {
                out.push(PeerEvent::Working);
            }
            return;
        }
        let Some(artifact) = update.get("artifact") else {
            out.push(PeerEvent::Working);
            return;
        };
        let id = self.artifact_id(artifact);
        let append = update
            .get("append")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let last = update
            .get("lastChunk")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut buffer = self.artifacts.remove(&id).unwrap_or_default();
        if !append {
            // `append: false` means this chunk is the artifact, not an addition to it. A first
            // chunk (where the field is absent) therefore replaces nothing, and a later one
            // replaces what came before, as the protocol reads it.
            buffer.text.clear();
            buffer.files.clear();
        }
        if buffer.name.is_none() {
            buffer.name = name_of(artifact);
        }
        add_parts(&mut buffer, artifact, &mut self.budget);
        if last {
            self.emit_artifact(buffer, out);
        } else {
            self.artifacts.insert(id, buffer);
            if !had_thread {
                out.push(PeerEvent::Working);
            }
        }
    }

    fn apply_message(&mut self, message: &Value, out: &mut Vec<PeerEvent>) {
        self.update_thread(message, out);
        if self.group && self.silent {
            out.push(PeerEvent::Done);
            self.terminal = true;
            return;
        }
        self.add_message(message, out);
        if self.saw_content || self.group {
            out.push(PeerEvent::Done);
        } else {
            out.push(PeerEvent::Failed(no_reply()));
        }
        self.terminal = true;
    }

    fn add_message(&mut self, message: &Value, out: &mut Vec<PeerEvent>) {
        let mut buffer = Artifact::default();
        add_parts(&mut buffer, message, &mut self.budget);
        if !buffer.text.trim().is_empty() {
            self.saw_content = true;
            out.push(PeerEvent::Said { text: buffer.text });
        }
        for file in buffer.files {
            self.saw_content = true;
            out.push(file_event(file));
        }
    }

    fn emit_artifact(&mut self, artifact: Artifact, out: &mut Vec<PeerEvent>) {
        if !artifact.text.trim().is_empty() {
            self.saw_content = true;
            self.saw_artifact_text = true;
            out.push(PeerEvent::Said {
                text: artifact.text,
            });
        }
        for file in artifact.files {
            self.saw_content = true;
            out.push(file_event(file));
        }
    }

    fn flush_artifacts(&mut self, out: &mut Vec<PeerEvent>) {
        for (_, artifact) in std::mem::take(&mut self.artifacts) {
            self.emit_artifact(artifact, out);
        }
    }

    fn artifact_id(&mut self, artifact: &Value) -> String {
        artifact
            .get("artifactId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                self.unnamed += 1;
                format!("unnamed-{}", self.unnamed)
            })
    }

    fn update_thread(&mut self, object: &Value, out: &mut Vec<PeerEvent>) {
        if self.group && says_silent(object) {
            self.silent = true;
        }
        if let Some(context_id) = object
            .get("contextId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            self.thread.context_id = Some(context_id.to_string());
        }
        if let Some(task_id) = object
            .get("taskId")
            .or_else(|| object.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            self.thread.task_id = Some(task_id.to_string());
        }
        if !self.thread.is_empty() && self.announced.as_ref() != Some(&self.thread) {
            self.announced = Some(self.thread.clone());
            out.push(PeerEvent::Thread(self.thread.clone()));
        }
    }
}

/// `metadata.silent: true` on a message, status, task or status update (brief §4.7).
fn says_silent(object: &Value) -> bool {
    let silent = |value: &Value| {
        value
            .get("metadata")
            .and_then(|metadata| metadata.get("silent"))
            .and_then(Value::as_bool)
            == Some(true)
    };
    silent(object)
        || object.get("status").is_some_and(silent)
        || object.get("message").is_some_and(silent)
}

fn no_reply() -> PeerError {
    PeerError::new("no_reply", "the other side finished without a reply")
}

fn file_event(file: PendingFile) -> PeerEvent {
    PeerEvent::File {
        name: file.name,
        media_type: file.media_type,
        bytes: file.bytes,
    }
}

fn name_of(artifact: &Value) -> Option<String> {
    artifact
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn media_type_of(part: &Value) -> Option<String> {
    part.get("mediaType")
        .and_then(Value::as_str)
        .filter(|media| !media.is_empty())
        .map(str::to_string)
}

fn filename_of(part: &Value) -> Option<String> {
    part.get("filename")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn add_parts(buffer: &mut Artifact, container: &Value, budget: &mut Budget) {
    if let Some(parts) = container.get("parts").and_then(Value::as_array) {
        for part in parts {
            add_part(buffer, part, budget);
        }
    }
}

fn add_part(buffer: &mut Artifact, part: &Value, budget: &mut Budget) {
    if let Some(text) = part.get("text").and_then(Value::as_str) {
        if buffer.text.len() + text.len() > TEXT_MAX {
            budget.overflow = true;
            return;
        }
        buffer.text.push_str(text);
    } else if let Some(raw) = part.get("raw").and_then(Value::as_str) {
        // Base64 is a third larger than what it carries; check before decoding, so a huge
        // piece is refused before it is in memory.
        if raw.len() as u64 / 4 * 3 > FILE_MAX {
            budget.overflow = true;
            return;
        }
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) {
            if !budget.charge(bytes.len() as u64) {
                return;
            }
            let media_type = media_type_of(part);
            let name = filename_of(part)
                .unwrap_or_else(|| format!("file.{}", extension(media_type.as_deref())));
            buffer.files.push(PendingFile {
                name,
                media_type,
                bytes: Bytes::from(bytes),
            });
        }
    } else if let Some(url) = part
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
    {
        // A link is not downloaded: it goes into the words, and the client opens it in the
        // built-in browser.
        if buffer
            .text
            .chars()
            .last()
            .is_some_and(|last| !last.is_whitespace())
        {
            buffer.text.push('\n');
        }
        let label = filename_of(part).unwrap_or_else(|| url.to_string());
        buffer.text.push_str(&format!("[{label}]({url})"));
    } else if let Some(data) = part.get("data")
        && let Ok(bytes) = serde_json::to_vec(data)
    {
        if !budget.charge(bytes.len() as u64) {
            return;
        }
        let mut name = filename_of(part)
            .or_else(|| buffer.name.clone())
            .unwrap_or_else(|| "data".to_string());
        if !name.ends_with(".json") {
            name.push_str(".json");
        }
        buffer.files.push(PendingFile {
            name,
            media_type: Some("application/json".to_string()),
            bytes: Bytes::from(bytes),
        });
    }
}

fn extension(media_type: Option<&str>) -> String {
    let Some(media_type) = media_type else {
        return "bin".to_string();
    };
    let bare = media_type
        .split(';')
        .next()
        .unwrap_or(media_type)
        .trim()
        .to_ascii_lowercase();
    let known = match bare.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/html" => "html",
        "text/csv" => "csv",
        "application/zip" => "zip",
        _ => {
            return bare
                .rsplit('/')
                .next()
                .filter(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()))
                .unwrap_or("bin")
                .to_string();
        }
    };
    known.to_string()
}

/// The `reason` in a JSON-RPC error's `data[]`, the name the protocol gives errors.
pub(crate) fn error_reason(error: &Value) -> Option<&str> {
    match error.get("data")? {
        Value::Array(items) => items
            .iter()
            .find_map(|item| item.get("reason").and_then(Value::as_str)),
        data => data.get("reason").and_then(Value::as_str),
    }
}

pub(crate) fn error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .unwrap_or("the other side refused the request")
        .to_string()
}

fn peer_error_from_error(error: &Value) -> PeerError {
    let message = error_message(error);
    match error_reason(error) {
        Some("TASK_NOT_FOUND") => PeerError::gone(message),
        Some("AUTH_REQUIRED") => PeerError::auth_required(message),
        _ => PeerError::new("bot_peer_failed", message),
    }
}

fn message_text(message: Option<&Value>, budget: &mut Budget) -> String {
    let mut buffer = Artifact::default();
    if let Some(message) = message {
        add_parts(&mut buffer, message, budget);
    }
    buffer.text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_budget_refuses_too_much_in_one_round() {
        let mut budget = Budget::default();
        assert!(budget.charge(FILE_MAX));
        assert!(!budget.charge(FILE_MAX + 1), "one file past its limit");
        let mut budget = Budget::default();
        for _ in 0..4 {
            assert!(budget.charge(FILE_MAX));
        }
        assert!(!budget.charge(1), "the round's limit");
    }

    #[test]
    fn too_much_text_stops_the_round() {
        let mut assembler = Assembler::default();
        let text = "x".repeat(TEXT_MAX + 1);
        let artifact = json!({ "artifactId": "a", "parts": [{ "text": text }] });
        let events = assembler.apply(&json!({ "result": { "artifactUpdate": {
            "taskId": "t", "contextId": "c", "artifact": artifact, "lastChunk": true
        }}}));
        assert!(matches!(&events[..], [PeerEvent::Failed(error)] if error.kind == "bot_peer_too_large"), "{events:?}");
        assert!(assembler.is_terminal());
    }

    fn labels(events: &[PeerEvent]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                PeerEvent::Thread(thread) => {
                    format!("thread:{:?}/{:?}", thread.context_id, thread.task_id)
                }
                PeerEvent::Working => "working".to_string(),
                PeerEvent::Said { text } => format!("said:{text}"),
                PeerEvent::File { name, .. } => format!("file:{name}"),
                PeerEvent::Asked { text } => format!("asked:{text}"),
                PeerEvent::Done => "done".to_string(),
                PeerEvent::Failed(error) => format!("failed:{}", error.kind),
            })
            .collect()
    }

    fn task(state: &str, message: Option<Value>) -> Value {
        let mut status = json!({ "state": state });
        if let Some(message) = message {
            status["message"] = message;
        }
        json!({
            "jsonrpc": "2.0", "id": "t1",
            "result": { "task": { "id": "task-1", "contextId": "ctx-1", "status": status } }
        })
    }

    fn artifact(id: &str, text: &str, append: Option<bool>, last: Option<bool>) -> Value {
        let mut update = json!({
            "artifactUpdate": {
                "taskId": "task-1", "contextId": "ctx-1",
                "artifact": { "artifactId": id, "name": "response", "parts": [{ "text": text }] }
            }
        });
        if let Some(append) = append {
            update["artifactUpdate"]["append"] = json!(append);
        }
        if let Some(last) = last {
            update["artifactUpdate"]["lastChunk"] = json!(last);
        }
        json!({ "jsonrpc": "2.0", "id": "t1", "result": update })
    }

    #[test]
    fn the_streamed_round_from_appendix_b_is_five_events() {
        let events = [
            json!({"result":{"task":{"id":"450d","contextId":"19da","status":{"state":"TASK_STATE_SUBMITTED"},"history":[]}},"id":"t1","jsonrpc":"2.0"}),
            json!({"result":{"statusUpdate":{"taskId":"450d","contextId":"19da","status":{"state":"TASK_STATE_WORKING"}}},"id":"t1","jsonrpc":"2.0"}),
            json!({"result":{"artifactUpdate":{"taskId":"450d","contextId":"19da","artifact":{"artifactId":"a02f","name":"response","parts":[{"text":"收到"}]}}},"id":"t1","jsonrpc":"2.0"}),
            json!({"result":{"artifactUpdate":{"taskId":"450d","contextId":"19da","artifact":{"artifactId":"a02f","name":"response","parts":[{"text":""}]},"append":true,"lastChunk":true}},"id":"t1","jsonrpc":"2.0"}),
            json!({"result":{"statusUpdate":{"taskId":"450d","contextId":"19da","status":{"state":"TASK_STATE_COMPLETED","message":{"messageId":"e47d","role":"ROLE_AGENT","parts":[{"text":"收到"}]}}}},"id":"t1","jsonrpc":"2.0"}),
        ];
        let mut assembler = Assembler::default();
        let mut out = Vec::new();
        for event in &events {
            out.extend(assembler.apply(event));
        }
        assert_eq!(
            labels(&out),
            [
                "thread:Some(\"19da\")/Some(\"450d\")",
                "working",
                "working",
                "said:收到",
                "done"
            ]
        );
        assert!(assembler.is_terminal());
    }

    #[test]
    fn the_non_streaming_shape_joins_the_parts_of_one_artifact() {
        let response = json!({
            "jsonrpc": "2.0", "id": "t1",
            "result": { "task": {
                "id": "task-1", "contextId": "ctx-1",
                "status": {
                    "state": "TASK_STATE_COMPLETED",
                    "message": { "messageId": "m", "role": "ROLE_AGENT", "parts": [{ "text": "A，B" }] }
                },
                "artifacts": [{ "artifactId": "a", "name": "response", "parts": [{ "text": "A" }, { "text": "，" }, { "text": "B" }] }]
            } }
        });
        let mut assembler = Assembler::default();
        let events = assembler.apply(&response);
        assert_eq!(
            labels(&events),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "said:A，B",
                "done"
            ]
        );
    }

    #[test]
    fn a_duplicate_status_message_is_not_a_second_said() {
        let mut assembler = Assembler::default();
        let first = assembler.apply(&task(
            "TASK_STATE_COMPLETED",
            Some(json!({ "parts": [{ "text": "收到" }] })),
        ));
        assert_eq!(
            labels(&first),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "said:收到",
                "done"
            ]
        );
        let second = assembler.apply(&task(
            "TASK_STATE_COMPLETED",
            Some(json!({ "parts": [{ "text": "收到" }] })),
        ));
        assert!(
            !labels(&second)
                .iter()
                .any(|label| label.starts_with("said:")),
            "{:?}",
            labels(&second)
        );
    }

    #[test]
    fn a_later_chunk_with_append_false_replaces_the_artifact() {
        let mut assembler = Assembler::default();
        assert_eq!(
            labels(&assembler.apply(&task("TASK_STATE_SUBMITTED", None))),
            ["thread:Some(\"ctx-1\")/Some(\"task-1\")"]
        );
        assert_eq!(
            labels(&assembler.apply(&artifact("a", "Hello", Some(false), Some(false)))),
            ["working"]
        );
        // `append: false` gives the artifact as a whole, so the earlier "Hello" is replaced.
        assert_eq!(
            labels(&assembler.apply(&artifact("a", "World", Some(false), Some(true)))),
            ["said:World"]
        );
    }

    #[test]
    fn an_unknown_result_is_working() {
        let mut assembler = Assembler::default();
        let events = assembler.apply(
            &json!({ "jsonrpc": "2.0", "id": "t1", "result": { "heartbeat": { "at": 1 } } }),
        );
        assert_eq!(labels(&events), ["working"]);
        assert!(!assembler.is_terminal());
    }

    #[test]
    fn input_required_asks_and_keeps_the_task() {
        let mut assembler = Assembler::default();
        let events = assembler.apply(&task(
            "TASK_STATE_INPUT_REQUIRED",
            Some(json!({ "parts": [{ "text": "Which day?" }] })),
        ));
        assert_eq!(
            labels(&events),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "asked:Which day?"
            ]
        );
        assert_eq!(assembler.thread().task_id.as_deref(), Some("task-1"));
        assert!(assembler.is_terminal());
    }

    #[test]
    fn files_are_raw_url_and_data() {
        let response = json!({
            "jsonrpc": "2.0", "id": "t1",
            "result": { "task": {
                "id": "task-1", "contextId": "ctx-1",
                "status": { "state": "TASK_STATE_COMPLETED" },
                "artifacts": [{ "artifactId": "a", "name": "response", "parts": [
                    { "text": "Here: " },
                    { "url": "https://example.com/report.pdf", "filename": "report.pdf" },
                    { "raw": "aGk=", "mediaType": "text/plain", "filename": "note.txt" },
                    { "data": { "ok": true } }
                ] }]
            } }
        });
        let mut assembler = Assembler::default();
        let events = assembler.apply(&response);
        assert_eq!(
            labels(&events),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "said:Here: [report.pdf](https://example.com/report.pdf)",
                "file:note.txt",
                "file:response.json",
                "done"
            ]
        );
        match &events[2] {
            PeerEvent::File { bytes, .. } => assert_eq!(bytes.as_ref(), b"hi"),
            other => panic!("expected a file, got {other:?}"),
        }
    }

    #[test]
    fn a_working_task_holds_its_artifact_until_the_subscription_closes_it() {
        let mut assembler = Assembler::default();
        let first = assembler.apply(&json!({
            "jsonrpc": "2.0", "id": 1,
            "result": {
                "id": "task-1", "contextId": "ctx-1",
                "status": { "state": "TASK_STATE_WORKING" },
                "artifacts": [{ "artifactId": "a", "name": "response", "parts": [{ "text": "partial" }] }]
            }
        }));
        assert_eq!(labels(&first), ["thread:Some(\"ctx-1\")/Some(\"task-1\")"]);
        // The subscription repeats the artifact and then closes it; only then does it speak.
        let closed = assembler.apply(&artifact("a", "", Some(true), Some(true)));
        assert_eq!(labels(&closed), ["said:partial"]);
        assert_eq!(
            labels(&assembler.apply(&task("TASK_STATE_COMPLETED", None))),
            ["done"]
        );
    }

    #[test]
    fn a_bare_task_from_get_task_is_read() {
        // The official 1.0 SDK answers `GetTask` with the task object as `result` itself.
        let mut assembler = Assembler::default();
        let events = assembler.apply(&json!({
            "jsonrpc": "2.0", "id": 1,
            "result": {
                "id": "task-1", "contextId": "ctx-1",
                "status": { "state": "TASK_STATE_COMPLETED", "message": { "parts": [{ "text": "finished" }] } },
                "artifacts": []
            }
        }));
        assert_eq!(
            labels(&events),
            [
                "thread:Some(\"ctx-1\")/Some(\"task-1\")",
                "said:finished",
                "done"
            ]
        );
        assert!(assembler.is_terminal());
    }

    #[test]
    fn a_group_round_without_content_is_silence_not_a_failure() {
        let mut assembler = Assembler::group();
        let events = assembler.apply(&task("TASK_STATE_COMPLETED", None));
        assert_eq!(labels(&events), ["thread:Some(\"ctx-1\")/Some(\"task-1\")", "done"]);
        assert!(assembler.is_terminal());
    }

    #[test]
    fn a_silent_metadata_keeps_the_reply_out() {
        let mut assembler = Assembler::group();
        let events = assembler.apply(&json!({
            "jsonrpc": "2.0", "id": 1,
            "result": { "task": {
                "id": "task-1", "contextId": "ctx-1",
                "status": {
                    "state": "TASK_STATE_COMPLETED",
                    "metadata": { "silent": true },
                    "message": { "parts": [{ "text": "should not be a said" }] }
                }
            } }
        }));
        assert_eq!(labels(&events), ["thread:Some(\"ctx-1\")/Some(\"task-1\")", "done"]);
    }

    #[test]
    fn a_terminal_state_without_content_is_no_reply() {
        let mut assembler = Assembler::default();
        let events = assembler.apply(&task("TASK_STATE_COMPLETED", None));
        assert_eq!(
            labels(&events),
            ["thread:Some(\"ctx-1\")/Some(\"task-1\")", "failed:no_reply"]
        );
    }
}
