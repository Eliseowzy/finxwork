//! Group chat (docs/kernel/bot-group-chat-design.md, docs/kernel/bot-group-chat-dev-brief.md
//! §4.1, §4.2, §4.12): a group is a service-layer conversation the owner and several bots share.
//! The group itself is not a kernel session; each local bot has a seat session of its own.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::bot::Avatar;

/// The group a seat session belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupRef {
    pub id: String,
    pub name: String,
}

/// How much of a group a member receives.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupMemberMode {
    /// Only messages that mention it, and the threads it takes part in.
    Mentions,
    /// The whole main flow, batched.
    #[default]
    Normal,
    /// Batched less often: every so often, or when enough arrived.
    Lazy,
}

/// What an external member sees of the group before it joined.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupHistory {
    /// Nothing.
    #[default]
    None,
    /// The rolling summary only.
    Summary,
    /// The rolling summary and the last few messages.
    Recent,
}

impl GroupHistory {
    fn is_none(&self) -> bool {
        matches!(self, GroupHistory::None)
    }
}

/// A member of a group, as the list and the group page show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupMember {
    pub bot_id: String,
    pub name: String,
    pub avatar: Avatar,
    /// Another subject's bot: the words go to its service.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub external: bool,
    pub mode: GroupMemberMode,
    /// What it may see of the time before it joined. Only external members have one.
    #[serde(default, skip_serializing_if = "GroupHistory::is_none")]
    pub history: GroupHistory,
    /// An external member that does not remember its context.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stateless: bool,
}

/// A file in a group message. `path` is relative to the group's directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

/// Who said a group message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GroupSpeaker {
    /// The owner of this computer.
    Owner,
    Bot {
        bot_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        external: bool,
    },
    /// A line the group keeps for itself: someone joined, a fuse stopped it.
    System,
}

/// What a reply quotes, so the client can draw its card without loading the whole group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupQuote {
    pub id: String,
    pub from: GroupSpeaker,
    pub text: String,
}

/// One message in a group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupMessage {
    pub id: String,
    /// From 0, increasing across the whole group: the main flow and every thread.
    pub seq: u64,
    /// RFC 3339.
    pub ts: String,
    pub from: GroupSpeaker,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<GroupFile>,
    /// The bots named with `@`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    /// The message this one quotes, if any. It stays in its own flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The first message of the thread this one is in; absent in the main flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_preview: Option<GroupQuote>,
}

/// A thread under its first message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupThread {
    /// The message the thread started from. It stays in the main flow.
    pub root: String,
    pub replies: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<GroupLast>,
}

/// A group's last message, for its row in the list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupLast {
    pub from: GroupSpeaker,
    /// The start of its text, at most 1000 characters.
    pub text: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub images: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub ts: String,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Why a group is stopped, and how it starts again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupStopReason {
    /// One bot said too much in a minute; only that bot waits.
    BotRate,
    /// The bots said enough after the owner's last message; the whole group waits.
    OwnerSilent,
    /// The group used its model budget for the day.
    DailyTokens,
    /// The group used its calls to external bots for the day.
    DailyPeerCalls,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupStop {
    pub reason: GroupStopReason,
    /// The bot that is waiting, for [`GroupStopReason::BotRate`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    /// What the user has to do, in their language.
    pub detail: String,
}

/// A group's counters for the day, and whether a fuse stopped it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupFuse {
    /// The local day the counters belong to.
    pub day: String,
    pub tokens: u64,
    pub peer_calls: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<GroupStop>,
}

/// A group, as the list and the group page's top bar show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    pub members: Vec<GroupMember>,
    /// At least one member is another subject's bot.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub external: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<GroupLast>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unread: u32,
    /// The bots answering now.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub typing: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<GroupStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuse: Option<GroupFuse>,
    /// Where the group's files are on this computer, for opening them from the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_dir: Option<String>,
    /// RFC 3339.
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupsResult {
    pub groups: Vec<GroupSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupsChangedParams {
    pub groups: Vec<GroupSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<String>,
}

/// A member a group is made with, or one added later.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupMemberInput {
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GroupMemberMode>,
    /// Required for an external bot: what it may see of the time before it joined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<GroupHistory>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupCreateParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub members: Vec<GroupMemberInput>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupUpdateParams {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// The owner's "continue" after the daily fuse stopped the group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupIdParams {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupAddMemberParams {
    pub id: String,
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GroupMemberMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<GroupHistory>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupRemoveMemberParams {
    pub id: String,
    pub bot_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupSetMemberParams {
    pub id: String,
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GroupMemberMode>,
    /// Whether the bot remembers its context; only an external member has this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stateless: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupOpenParams {
    pub id: String,
    /// Only messages with a smaller `seq`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupThreadParams {
    pub id: String,
    /// The first message of the thread.
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupSendParams {
    pub id: String,
    #[serde(default)]
    pub text: String,
    /// Files on this computer to put into the group's folder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The first message of the thread to reply in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupOpenResult {
    pub group: GroupSummary,
    /// The main flow, oldest first.
    pub messages: Vec<GroupMessage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<GroupThread>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupThreadResult {
    pub messages: Vec<GroupMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupSendResult {
    pub message: GroupMessage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupMessageParams {
    pub group_id: String,
    pub message: GroupMessage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupActivityParams {
    pub group_id: String,
    pub bot_id: String,
    pub busy: bool,
}

/// Why a confirmation is shown: the message that set the group on this bot, as the owner sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupCauseKind {
    /// A message of this batch is from an external member.
    Direct,
    /// The seat session has seen an external message before; this turn is the owner's.
    Earlier,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GroupApprovalCause {
    pub kind: GroupCauseKind,
    /// The external member whose words came first, if it is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// The first 200 characters of that message.
    pub text: String,
}

/// A confirmation a seat session's call asks for, for the group page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GroupApprovalParams {
    pub group_id: String,
    pub bot_id: String,
    pub session_id: String,
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub cause: GroupApprovalCause,
}