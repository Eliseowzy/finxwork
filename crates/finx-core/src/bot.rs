//! Bots (bot-design): a bot is a name, an avatar and one session. Its session has one tool
//! of its own, `send_to_user`, the only way what it writes reaches the user: words, files and
//! images, or a question with answers to tap (§3.12).

use async_trait::async_trait;
use finx_llm::Message;
use finx_protocol::AgentStatus;
use finx_tools::Environment;
use finx_tools::Tool;
use finx_tools::ToolCategory;
use finx_tools::ToolCtx;
use finx_tools::ToolDescription;
use finx_tools::ToolError;
use finx_tools::ToolOutput;
use finx_tools::Typed;
use finx_tools::TypedTool;
use finx_tools::builtin::read::find_path_variant;
use finx_tools::image::ImageFormat;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::sync::Arc;

use crate::files::MAX_IMAGE;
use crate::history::History;
use crate::store::EntryKind;

/// The bot a session is started for: its id, and its name now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BotIdentity {
    pub id: String,
    pub name: String,
}

pub const SEND_TO_USER: &str = "send_to_user";

/// The tools a bot's session gets on top of a session's. Its sub-agents do not get them: their
/// replies are reports to the bot.
pub(crate) fn tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Typed::new(SendToUser))]
}

/// What a bot about to end its turn still owes its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Owed {
    Nothing,
    /// Nothing reached them since their latest message (bot-design §3.11). The message may be an
    /// earlier task's, as when a failed task is retried.
    Reply,
    /// Something came of its work since its last message: a report, or the results of its tools
    /// (bot-turn-design §6). It may have nothing worth telling.
    Delivery,
}

/// Looks back from the end of the history to the last message that reached the owner.
pub(crate) fn owed(history: &History) -> Owed {
    let mut worked = false;
    for entry in history.branch_back() {
        match &entry.kind {
            EntryKind::Message {
                message: Message::ToolResult(result),
                ..
            } => {
                if result.tool_name == SEND_TO_USER && !result.is_error {
                    break;
                }
                // Starting an agent or telling it something gives the owner nothing to hear.
                worked |= !matches!(result.tool_name.as_str(), "spawn_agent" | "send_message");
            }
            EntryKind::Message {
                message: Message::User(_), ..
            } => return Owed::Reply,
            // A stopped agent's report wakes nobody, and nobody waits for it.
            EntryKind::Mail { mail, .. } => worked |= mail.status != AgentStatus::Interrupted,
            EntryKind::AgentMessage { .. } => worked = true,
            _ => {}
        }
    }
    if worked { Owed::Delivery } else { Owed::Nothing }
}

/// Whether a call sends files: by its type, or without one by what it carries (bot-design §3.12).
pub fn sends_files(args: &Value) -> bool {
    match args.get("type").and_then(Value::as_str) {
        Some(kind) => kind == "attachment",
        None => args.get("files").and_then(Value::as_array).is_some_and(|files| !files.is_empty()),
    }
}

/// What a message of files carried, from its result's details (bot-design §3.12): its words, how
/// many images, and the name of its first other file. None for any other message.
pub fn attachment_summary(details: &str) -> Option<(String, u32, Option<String>)> {
    let details: Value = serde_json::from_str(details).ok()?;
    let files = details.get("files")?.as_array()?;
    let text = details.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    let images = files.iter().filter(|f| f.get("image").is_some()).count();
    let file = files
        .iter()
        .find(|f| f.get("image").is_none())
        .and_then(|f| Path::new(f.get("path")?.as_str()?).file_name()?.to_str())
        .map(str::to_string);
    Some((text, images as u32, file))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum MessageType {
    Text,
    Attachment,
    Question,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct FileArg {
    /// A file on this computer, absolute or relative to your folder. Save anything from the web to a file first.
    path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct OptionArg {
    /// The answer.
    label: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SendArgs {
    /// What this message is. text (the default): words, rendered as Markdown. attachment: one or more files or images, with words if they help. question: a question, when you need the user to decide; it ends your turn and their answer comes back as their next message; send any background first as a text message.
    #[serde(default, rename = "type")]
    kind: Option<MessageType>,
    /// The message. For attachment, the words to go with the files. For question, the question in one sentence.
    #[serde(default)]
    text: Option<String>,
    /// For attachment, what to send, in order.
    #[serde(default)]
    files: Option<Vec<FileArg>>,
    /// For question, answers the user can tap, each worded the way they would say it. Leave it out when the answers cannot be listed.
    #[serde(default)]
    options: Option<Vec<OptionArg>>,
    /// True on your last message, once your work for now is done: the turn ends right after it. Leave it out for a first reply or an update while you keep working.
    #[serde(default)]
    end_turn: bool,
}

/// Enough of a file for an image's size in its header.
const IMAGE_HEAD: u64 = 256 * 1024;

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::InvalidArgs(message.into())
}

/// A file's entry in the result's details, for user interfaces: where it is, how large, and for
/// an image the panel can show (by its contents, like the file panel) its size. Or why it cannot
/// be sent. Looked at when the call runs: the model may make the file in the same step.
async fn sent_file(env: &dyn Environment, raw: &str) -> Result<Value, String> {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Err(format!("{raw}: a web address, save it to a file first"));
    }
    let mut path = env.resolve(raw);
    let mut meta = env.metadata(&path).await;
    if matches!(&meta, Err(err) if err.kind() == io::ErrorKind::NotFound)
        && let Some(found) = find_path_variant(env, raw).await
    {
        meta = env.metadata(&found).await;
        path = found;
    }
    let meta = match meta {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Err(format!("{raw}: no such file")),
        Err(err) => return Err(format!("{raw}: {err}")),
    };
    if !meta.is_file {
        return Err(format!("{raw}: not a file"));
    }
    let mut file = json!({ "path": path, "size": meta.size });
    if meta.size <= MAX_IMAGE
        && let Ok(head) = env.read_file(&path, IMAGE_HEAD).await
        && let Some(format) = ImageFormat::detect(&head.bytes)
    {
        file["image"] = json!(true);
        if let Some((width, height)) = format.dimensions(&head.bytes) {
            file["width"] = json!(width);
            file["height"] = json!(height);
        }
    }
    Ok(file)
}

struct SendToUser;

#[async_trait]
impl TypedTool for SendToUser {
    type Args = SendArgs;
    const NAME: &'static str = SEND_TO_USER;
    const DESCRIPTION: &'static str = "Send a message to the user. It is the only way they see anything from you: each call \
        shows up as one message, all at once.";

    fn describe(&self, args: &Value, _env: &dyn Environment) -> ToolDescription {
        let first = args
            .get("text")
            .and_then(Value::as_str)
            .and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()))
            .map(str::to_string);
        let files = || {
            let names: Vec<&str> = args
                .get("files")?
                .as_array()?
                .iter()
                .filter_map(|f| Path::new(f.get("path")?.as_str()?).file_name()?.to_str())
                .collect();
            (!names.is_empty()).then(|| names.join(", "))
        };
        ToolDescription {
            category: ToolCategory::Other,
            title: match first.or_else(files) {
                Some(line) => line.chars().take(80).collect(),
                None => SEND_TO_USER.to_string(),
            },
            locations: Vec::new(),
        }
    }

    async fn run(&self, args: SendArgs, ctx: ToolCtx) -> Result<ToolOutput, ToolError> {
        // An empty value is no value: some models fill in every optional parameter.
        let text = args.text.as_deref().filter(|text| !text.trim().is_empty());
        let files = args.files.unwrap_or_default();
        let options = args.options.unwrap_or_default();
        let sent = ToolOutput::text("Sent.");
        // Without a type, what it carries says what it is.
        let kind = args.kind.unwrap_or(if !files.is_empty() {
            MessageType::Attachment
        } else if !options.is_empty() {
            MessageType::Question
        } else {
            MessageType::Text
        });
        if kind != MessageType::Attachment && !files.is_empty() {
            return Err(invalid("files goes with type attachment"));
        }
        if kind != MessageType::Question && !options.is_empty() {
            return Err(invalid("options goes with type question"));
        }
        let output = match kind {
            MessageType::Text => {
                if text.is_none() {
                    return Err(invalid("text must not be empty"));
                }
                sent
            }
            MessageType::Attachment => {
                if files.is_empty() {
                    return Err(invalid("give at least one file"));
                }
                let mut details = Vec::with_capacity(files.len());
                let mut wrong = Vec::new();
                for file in &files {
                    match sent_file(ctx.env.as_ref(), &file.path).await {
                        Ok(file) => details.push(file),
                        Err(why) => wrong.push(why),
                    }
                }
                if !wrong.is_empty() {
                    return Err(ToolError::Failed(wrong.join("; ")));
                }
                let mut said = json!({ "files": details });
                if let Some(text) = text {
                    said["text"] = json!(text);
                }
                sent.with_details(said)
            }
            MessageType::Question => {
                if text.is_none() {
                    return Err(invalid("text must not be empty"));
                }
                let mut seen = HashSet::new();
                for option in &options {
                    let label = option.label.trim();
                    if label.is_empty() {
                        return Err(invalid("an option's label must not be empty"));
                    }
                    if !seen.insert(label) {
                        return Err(invalid(format!("two options have the same label: {label}")));
                    }
                }
                return Ok(sent.ending_task());
            }
        };
        Ok(if args.end_turn { output.ending_task() } else { output })
    }
}
