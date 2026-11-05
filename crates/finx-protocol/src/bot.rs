//! Bots (docs/kernel/bot-design.md §4): a bot is a name, an avatar and one conversation, a
//! session the server keeps for it. The `bots/*` methods manage bots; the conversation uses
//! the session methods once `bots/open` has attached it.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

use crate::api::EventFilter;

/// The characters an avatar can show, drawn by the client.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AvatarShape {
    Round,
    Box,
    Ghost,
    Cloud,
    Dome,
    Cat,
    Egg,
    Gem,
}

/// The colours behind an avatar's character or initial: muted, the same in both themes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AvatarHue {
    Slate,
    Sage,
    Clay,
    Ochre,
    Plum,
    Teal,
    Rose,
    Stone,
}

/// A bot's avatar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Avatar {
    /// The FinxWork mark: the default bot's alone.
    Mark,
    /// A character on a colour.
    Char { shape: AvatarShape, hue: AvatarHue },
    /// The first character of the bot's name on a colour.
    Mono { hue: AvatarHue },
    /// An image uploaded for the bot, which `bots/avatar` gives; `rev` changes with each one.
    Image { rev: u32 },
}

/// An avatar given to `bots/create` and `bots/update`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AvatarInput {
    Mark,
    Char { shape: AvatarShape, hue: AvatarHue },
    Mono { hue: AvatarHue },
    /// A square PNG, base64, which the client cropped and scaled (256 px).
    Image { png: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    User,
    Bot,
}

/// The last message of a bot's conversation, for its row in the list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LastMessage {
    pub from: Speaker,
    /// The start of its text as written (at most 1000 characters): the client takes the line
    /// to show from it, as it does for the conversation.
    pub text: String,
    /// The images it carried.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub images: u32,
    /// A bot's message of files: the name of the first that is not an image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// RFC 3339.
    pub ts: String,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotSummary {
    pub id: String,
    pub name: String,
    pub avatar: Avatar,
    /// The bot every user has: it cannot be deleted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// Its conversation, once there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<LastMessage>,
    /// Messages and approval requests since the user last looked (`bots/read`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unread: u32,
    /// It is answering: its conversation runs a task.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub typing: bool,
    /// Background helpers (sub-agents) at work.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub helpers: u32,
    /// The oldest approval it waits for: what the call does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
    /// Its last task failed, so no message may be coming. Only while its conversation is loaded.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
    /// The owner asked not to be alerted about this bot, on any device.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub muted: bool,
    /// RFC 3339.
    pub created_at: String,
}

/// Result of `bots/subscribe`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotsResult {
    pub bots: Vec<BotSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotCreateParams {
    /// 1 to 20 characters once trimmed.
    pub name: String,
    pub avatar: AvatarInput,
}

/// Result of `bots/create` and `bots/update`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotResult {
    pub bot: BotSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotUpdateParams {
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<AvatarInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
}

/// Parameters of `bots/avatar`, `bots/read`, `bots/unread`, `bots/clear` and `bots/delete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotIdParams {
    pub bot_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotAvatarResult {
    /// `data:image/png;base64,…`
    pub data: String,
}

/// Parameters of `bots/open`, which answers as `session/new` does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BotOpenParams {
    pub bot_id: String,
    #[serde(default)]
    pub events: EventFilter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<u32>,
}

/// Server notification to `bots/subscribe`rs: the bots that changed, and those deleted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BotsChangedParams {
    pub bots: Vec<BotSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<String>,
}
