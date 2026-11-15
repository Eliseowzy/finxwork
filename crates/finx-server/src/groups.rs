//! Groups (docs/kernel/bot-group-chat-dev-brief.md §4.1): where the owner and several bots talk.
//! The group itself is service-layer state, not a kernel session; a local bot's seat session is
//! made in M2. This file keeps `group.json`, `messages.jsonl` and the group's folder, and answers
//! the `groups/*` methods.

use bytes::Bytes;
use finx_core::BotIdentity;
use finx_core::FinxHome;
use finx_core::StartOptions;
use finx_core::config::GroupsSettings;
use finx_core::Workspace;
use finx_core::config_edit::replace_file;
use finx_protocol::api::method;
use finx_protocol::bot::Avatar;
use finx_protocol::bot::AvatarHue;
use finx_protocol::group::*;
use finx_rpc::RpcError;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Weak;

use crate::bots;
use crate::conn::ConnHandle;
use crate::hub::HubCmd;
use crate::hub::Listing;
use crate::hub::SummaryBase;
use crate::errors;
use crate::list::ListFeed;
use crate::list::now;
use crate::server::Server;

/// `group.json`'s version.
const VERSION: u32 = 1;
/// Characters in a group name, once trimmed.
const NAME_MAX: usize = 40;
/// Messages one `groups/open` or `groups/thread` returns unless it asks for fewer.
const PAGE: usize = 50;
const PAGE_MAX: usize = 200;
/// Characters of a message's text kept in the list row.
const LAST_TEXT_MAX: usize = 1000;

/// What `group.json` holds.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct GroupData {
    version: u32,
    id: String,
    name: String,
    #[serde(default)]
    note: String,
    created_at: String,
    #[serde(default)]
    pinned: bool,
    members: Vec<MemberFile>,
    next_seq: u64,
    #[serde(default)]
    summary: SummaryFile,
    /// An external member's delivery state, by bot id: its contexts and what it has seen.
    #[serde(default)]
    peers: BTreeMap<String, PeerFile>,
    #[serde(default)]
    fuse: FuseFile,
    #[serde(default)]
    summary_list: Kept,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct MemberFile {
    bot_id: String,
    #[serde(default)]
    mode: GroupMemberMode,
    joined_at: String,
    joined_seq: u64,
    #[serde(default)]
    history: GroupHistory,
    /// The seat session, once there is one (M2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SummaryFile {
    #[serde(default)]
    upto_seq: u64,
    #[serde(default)]
    text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct PeerFile {
    stateless: bool,
    /// By stream: `main`, or the first message of a thread.
    contexts: BTreeMap<String, ContextFile>,
    /// Whether the member list went to this bot; sent again after a member changes.
    #[serde(default)]
    members_sent: bool,
}

/// What the group needs to know about an external member (brief §4.7).
#[derive(Clone, Debug)]
pub(crate) struct ExternalMember {
    pub bot_id: String,
    pub name: String,
    pub mode: GroupMemberMode,
    pub history: GroupHistory,
    pub joined_seq: u64,
    pub stateless: bool,
}

/// An external member's delivery state, copied out of `group.json`.
#[derive(Clone, Debug, Default)]
pub(crate) struct PeerState {
    pub stateless: bool,
    pub members_sent: bool,
    /// By stream: `main`, or the first message of a thread.
    pub contexts: BTreeMap<String, PeerContext>,
}

#[derive(Clone, Debug)]
pub(crate) struct PeerContext {
    pub context_id: String,
    pub sent_seq: u64,
}

/// A file the other side gave, not yet written into the group's folder.
#[derive(Clone, Debug)]
pub(crate) struct PeerIncomingFile {
    pub name: String,
    pub media_type: Option<String>,
    pub bytes: Bytes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ContextFile {
    context_id: String,
    sent_seq: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct FuseFile {
    #[serde(default)]
    day: String,
    #[serde(default)]
    tokens: u64,
    #[serde(default)]
    peer_calls: u32,
    #[serde(default)]
    stopped: Option<GroupStop>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    last: Option<GroupLast>,
    #[serde(default)]
    unread: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct MessageFile {
    id: String,
    seq: u64,
    ts: String,
    from: FromFile,
    #[serde(default)]
    text: String,
    #[serde(default)]
    files: Vec<GroupFile>,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    reply_to: Option<String>,
    #[serde(default)]
    thread: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FromFile {
    Owner,
    Bot { bot_id: String },
    System,
}

struct Group {
    file: GroupData,
    /// Read from `messages.jsonl` when first needed.
    messages: Option<Vec<MessageFile>>,
}

impl Group {
    /// Reads this group's messages into memory, once.
    fn ensure_messages(&mut self, home: &FinxHome) -> Result<(), RpcError> {
        if self.messages.is_none() {
            self.messages = Some(read_messages(&home.group_dir(&self.file.id))?);
        }
        Ok(())
    }
}

/// Every group, and who follows the list.
pub(crate) struct Registry {
    home: FinxHome,
    bots: Arc<bots::Registry>,
    /// `bots.external`: whether another subject's bot may join.
    external: bool,
    /// `[groups]`: quiet periods and fuses.
    settings: GroupsSettings,
    /// `None` until read from disk, on first use.
    groups: Mutex<Option<BTreeMap<String, Group>>>,
    feed: ListFeed,
    /// One `group.json` write at a time.
    writing: Mutex<()>,
    /// The service, once it exists: what a seat's words go to.
    host: Mutex<Option<Weak<crate::server::Inner>>>,
    /// What each seat is answering: the auto topic and the batch's range.
    seat_turns: Mutex<BTreeMap<(String, String), SeatTurn>>,
    /// Fuse 1's per-bot minute: `(minute, messages)`.
    bot_minute: Mutex<BTreeMap<(String, String), (i64, u32)>>,
    /// Fuse 1's messages since the owner's last message, by group.
    consecutive: Mutex<BTreeMap<String, u32>>,
    /// What set each seat's current turn on, for a confirmation card.
    seat_causes: Mutex<BTreeMap<(String, String), GroupApprovalCause>>,
}

#[derive(Clone, Debug, Default)]
struct SeatTurn {
    thread: Option<String>,
    from_seq: u64,
    to_seq: u64,
}

impl Registry {
    pub(crate) fn new(home: FinxHome, bots: Arc<bots::Registry>, external: bool, settings: GroupsSettings) -> Self {
        Self {
            home,
            bots,
            external,
            settings,
            groups: Mutex::new(None),
            feed: ListFeed::default(),
            writing: Mutex::new(()),
            host: Mutex::new(None),
            seat_turns: Mutex::new(BTreeMap::new()),
            bot_minute: Mutex::new(BTreeMap::new()),
            consecutive: Mutex::new(BTreeMap::new()),
            seat_causes: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) fn settings(&self) -> &GroupsSettings {
        &self.settings
    }

    pub(crate) fn set_host(&self, host: Weak<crate::server::Inner>) {
        *self.host.lock() = Some(host);
    }

    fn server(&self) -> Option<crate::server::Server> {
        self.host.lock().as_ref()?.upgrade().map(crate::server::Server)
    }

    pub(crate) fn set_seat_turn(&self, group: &str, bot: &str, thread: Option<String>, from_seq: u64, to_seq: u64) {
        self.seat_turns
            .lock()
            .insert((group.to_string(), bot.to_string()), SeatTurn { thread, from_seq, to_seq });
    }

    pub(crate) fn seat_turn_for(&self, group: &str, bot: &str) -> Option<String> {
        self.seat_turn(group, bot).thread
    }

    fn seat_turn(&self, group: &str, bot: &str) -> SeatTurn {
        self.seat_turns
            .lock()
            .get(&(group.to_string(), bot.to_string()))
            .cloned()
            .unwrap_or_default()
    }

    /// A seat said something: put it in the group, then let the service pass it on.
    pub(crate) fn on_seat_spoke(&self, group: &str, bot: &str, args: &Value, details: Option<&Value>) {
        if let Some(server) = self.server() {
            server.group_seat_spoke(group, bot, args, details);
        }
    }

    pub(crate) fn on_seat_silent(&self, group: &str, bot: &str, explicit: bool, reason: Option<&str>) {
        let turn = self.seat_turn(group, bot);
        let _ = self.silence(group, bot, turn.from_seq, turn.to_seq, explicit, reason);
    }

    pub(crate) fn on_seat_busy(&self, group: &str, bot: &str, busy: bool) {
        self.feed.send(Bytes::from(finx_rpc::notification(
            method::GROUP_ACTIVITY,
            &GroupActivityParams {
                group_id: group.to_string(),
                bot_id: bot.to_string(),
                busy,
            },
        )));
    }

    pub(crate) fn watch(&self, conn: &ConnHandle) {
        self.feed.watch(conn);
    }

    pub(crate) fn start(&self, conn: &ConnHandle, response: Vec<u8>) {
        self.feed.start(conn, response);
    }

    pub(crate) fn stop_watching(&self, conn: crate::conn::ConnId) {
        self.feed.cancel(conn);
    }

    fn with<R>(&self, f: impl FnOnce(&mut BTreeMap<String, Group>) -> R) -> R {
        let mut groups = self.groups.lock();
        let groups = groups.get_or_insert_with(|| read_all(&self.home));
        f(groups)
    }

    fn with_group<R>(&self, id: &str, f: impl FnOnce(&mut Group) -> Result<R, RpcError>) -> Result<R, RpcError> {
        self.with(|groups| {
            let group = groups.get_mut(id).ok_or_else(|| errors::group_not_found(id))?;
            let today = today();
            if group.file.fuse.day != today {
                group.file.fuse.day = today;
                group.file.fuse.tokens = 0;
                group.file.fuse.peer_calls = 0;
                if matches!(
                    group.file.fuse.stopped.as_ref().map(|s| s.reason),
                    Some(GroupStopReason::DailyTokens | GroupStopReason::DailyPeerCalls)
                ) {
                    group.file.fuse.stopped = None;
                }
            }
            f(group)
        })
    }

    fn save(&self, id: &str) -> Result<(), RpcError> {
        let _writing = self.writing.lock();
        let Some(file) = self.with(|groups| groups.get(id).map(|g| g.file.clone())) else {
            return Ok(());
        };
        write_file(&self.home, &file)
    }

    fn announce(&self, ids: &[&str], deleted: Vec<String>) {
        let groups = self.rows(|id| ids.contains(&id));
        self.feed.send(Bytes::from(finx_rpc::notification(
            method::GROUPS_CHANGED,
            &GroupsChangedParams { groups, deleted },
        )));
    }

    fn publish(&self, group_id: &str, message: &GroupMessage) {
        self.feed.send(Bytes::from(finx_rpc::notification(
            method::GROUP_MESSAGE,
            &GroupMessageParams {
                group_id: group_id.to_string(),
                message: message.clone(),
            },
        )));
    }

    /// Every group's row, or those `keep` says.
    fn rows(&self, keep: impl Fn(&str) -> bool) -> Vec<GroupSummary> {
        self.with(|groups| groups.values().filter(|g| keep(&g.file.id)).map(|g| self.summary(g)).collect())
    }

    fn summary(&self, group: &Group) -> GroupSummary {
        let mut external = false;
        let members: Vec<GroupMember> = group
            .file
            .members
            .iter()
            .map(|m| {
                let info = self.bots.member_info(&m.bot_id);
                let (name, avatar, is_external) = match &info {
                    Some(info) => (info.name.clone(), info.avatar.clone(), info.external),
                    None => (m.bot_id.clone(), Avatar::Mono { hue: AvatarHue::Slate }, false),
                };
                external |= is_external;
                GroupMember {
                    bot_id: m.bot_id.clone(),
                    name,
                    avatar,
                    external: is_external,
                    mode: m.mode,
                    history: m.history,
                }
            })
            .collect();
        GroupSummary {
            id: group.file.id.clone(),
            name: group.file.name.clone(),
            note: (!group.file.note.is_empty()).then(|| group.file.note.clone()),
            pinned: group.file.pinned,
            members,
            external,
            last: group.file.summary_list.last.clone(),
            unread: group.file.summary_list.unread,
            typing: Vec::new(),
            stopped: group.file.fuse.stopped.clone(),
            fuse: Some(GroupFuse {
                day: day(&group.file.fuse),
                tokens: group.file.fuse.tokens,
                peer_calls: group.file.fuse.peer_calls,
                stopped: group.file.fuse.stopped.clone(),
            }),
            created_at: group.file.created_at.clone(),
        }
    }

    pub(crate) fn row(&self, id: &str) -> Result<GroupSummary, RpcError> {
        self.with(|groups| groups.get(id).map(|g| self.summary(g))).ok_or_else(|| errors::group_not_found(id))
    }

    pub(crate) fn create(&self, p: GroupCreateParams) -> Result<GroupSummary, RpcError> {
        let name = clean_name(&p.name)?;
        let note = p.note.unwrap_or_default().trim().to_string();
        let mut members = Vec::new();
        for input in p.members {
            if members.iter().any(|m: &MemberFile| m.bot_id == input.bot_id) {
                return Err(errors::group_member_exists(&input.bot_id));
            }
            members.push(self.member(input)?);
        }
        let id = uuid::Uuid::now_v7().to_string();
        let file = GroupData {
            version: VERSION,
            id: id.clone(),
            name,
            note,
            created_at: now(),
            pinned: false,
            members,
            next_seq: 0,
            summary: SummaryFile::default(),
            peers: BTreeMap::new(),
            fuse: FuseFile {
                day: today(),
                ..FuseFile::default()
            },
            summary_list: Kept::default(),
        };
        make_dirs(&self.home, &id)?;
        write_file(&self.home, &file)?;
        touch_messages(&self.home, &id)?;
        self.with(|groups| {
            groups.insert(id.clone(), Group { file, messages: Some(Vec::new()) });
        });
        let row = self.row(&id)?;
        self.announce(&[&id], Vec::new());
        Ok(row)
    }

    /// A member from the parameters of create or add_member.
    fn member(&self, input: GroupMemberInput) -> Result<MemberFile, RpcError> {
        let info = self.bots.member_info(&input.bot_id).ok_or_else(|| errors::bot_not_found(&input.bot_id))?;
        if info.external && !self.external {
            return Err(errors::group_external_disabled());
        }
        let history = if info.external {
            input
                .history
                .ok_or_else(|| RpcError::invalid_params("history is required for another subject's bot"))?
        } else {
            GroupHistory::None
        };
        Ok(MemberFile {
            bot_id: input.bot_id,
            mode: input.mode.unwrap_or_default(),
            joined_at: now(),
            joined_seq: 0,
            history,
            session_id: None,
        })
    }

    pub(crate) fn update(&self, p: GroupUpdateParams) -> Result<(), RpcError> {
        if let Some(name) = &p.name {
            let name = clean_name(name)?;
            self.with_group(&p.id, |g| {
                g.file.name = name;
                Ok(())
            })?;
        }
        if let Some(note) = &p.note {
            let note = note.trim().to_string();
            self.with_group(&p.id, |g| {
                g.file.note = note;
                Ok(())
            })?;
        }
        if let Some(pinned) = p.pinned {
            self.with_group(&p.id, |g| {
                g.file.pinned = pinned;
                Ok(())
            })?;
        }
        if p.resume == Some(true) {
            self.with_group(&p.id, |g| {
                if matches!(
                    g.file.fuse.stopped.as_ref().map(|s| s.reason),
                    Some(GroupStopReason::DailyTokens | GroupStopReason::DailyPeerCalls)
                ) {
                    g.file.fuse.stopped = None;
                    // The owner's "continue" gives the day another allowance (brief §4.8).
                    g.file.fuse.tokens = 0;
                    g.file.fuse.peer_calls = 0;
                }
                Ok(())
            })?;
        }
        self.save(&p.id)?;
        self.announce(&[&p.id], Vec::new());
        Ok(())
    }

    pub(crate) fn delete(&self, id: &str) -> Result<(), RpcError> {
        // A save that started before this delete must finish before the folder moves, or it
        // would write a fresh group.json at the old path (and the group would come back).
        let _writing = self.writing.lock();
        let existing = self.with(|groups| groups.get(id).map(|g| g.file.id.clone())).ok_or_else(|| errors::group_not_found(id))?;
        let dir = self.home.group_dir(&existing);
        let trash = self.home.trash_groups_dir();
        private_dir(&trash).map_err(io_error)?;
        let target = unique_dir(&trash, &existing);
        std::fs::rename(&dir, &target).map_err(io_error)?;
        self.with(|groups| groups.remove(id));
        self.announce(&[], vec![id.to_string()]);
        Ok(())
    }

    pub(crate) fn add_member(&self, p: GroupAddMemberParams) -> Result<GroupSummary, RpcError> {
        let member = self.member(GroupMemberInput {
            bot_id: p.bot_id.clone(),
            mode: p.mode,
            history: p.history,
        })?;
        self.with_group(&p.id, |g| {
            if g.file.members.iter().any(|m| m.bot_id == p.bot_id) {
                return Err(errors::group_member_exists(&p.bot_id));
            }
            let joined_seq = g.file.next_seq;
            g.file.members.push(MemberFile { joined_seq, ..member });
            Ok(())
        })?;
        self.save(&p.id)?;
        let row = self.row(&p.id)?;
        self.announce(&[&p.id], Vec::new());
        Ok(row)
    }

    pub(crate) fn remove_member(&self, p: GroupRemoveMemberParams) -> Result<(), RpcError> {
        self.with_group(&p.id, |g| {
            let before = g.file.members.len();
            g.file.members.retain(|m| m.bot_id != p.bot_id);
            g.file.peers.remove(&p.bot_id);
            if g.file.members.len() == before {
                return Err(RpcError::invalid_params(format!("bot {} is not in the group", p.bot_id)));
            }
            Ok(())
        })?;
        self.save(&p.id)?;
        self.announce(&[&p.id], Vec::new());
        Ok(())
    }

    pub(crate) fn set_member(&self, p: GroupSetMemberParams) -> Result<(), RpcError> {
        let external = self.bots.member_info(&p.bot_id).is_some_and(|i| i.external);
        if p.stateless.is_some() && !external {
            return Err(RpcError::invalid_params("stateless is only for another subject's bot"));
        }
        self.with_group(&p.id, |g| {
            let member = g
                .file
                .members
                .iter_mut()
                .find(|m| m.bot_id == p.bot_id)
                .ok_or_else(|| RpcError::invalid_params(format!("bot {} is not in the group", p.bot_id)))?;
            if let Some(mode) = p.mode {
                member.mode = mode;
            }
            if let Some(stateless) = p.stateless {
                g.file.peers.entry(p.bot_id.clone()).or_default().stateless = stateless;
            }
            Ok(())
        })?;
        self.save(&p.id)?;
        self.announce(&[&p.id], Vec::new());
        Ok(())
    }

    pub(crate) fn open(&self, p: GroupOpenParams) -> Result<GroupOpenResult, RpcError> {
        let limit = page_limit(p.limit);
        self.with_group(&p.id, |g| {
            g.ensure_messages(&self.home)?;
            let group = self.summary(g);
            let messages = g.messages.as_ref().expect("read above");
            let before = p.before_seq.unwrap_or(u64::MAX);
            let main: Vec<&MessageFile> = messages.iter().filter(|m| m.thread.is_none() && m.seq < before).collect();
            let start = main.len().saturating_sub(limit);
            let shown: Vec<GroupMessage> = main[start..].iter().map(|m| self.message(m, messages)).collect();
            // One pass over the replies, then only the roots on this page: opening a long
            // group must not scan every message for every root.
            let mut counts: HashMap<&str, (u32, Option<&MessageFile>)> = HashMap::new();
            for m in messages.iter().filter(|m| m.thread.is_some()) {
                let root = m.thread.as_deref().expect("filtered");
                let entry = counts.entry(root).or_insert((0, None));
                entry.0 += 1;
                entry.1 = Some(m);
            }
            let mut threads = Vec::new();
            for m in &shown {
                if let Some((replies, last)) = counts.get(m.id.as_str()) {
                    threads.push(GroupThread {
                        root: m.id.clone(),
                        replies: *replies,
                        last: last.map(|x| self.last(x)),
                    });
                }
            }
            Ok(GroupOpenResult { group, messages: shown, threads })
        })
    }

    pub(crate) fn thread(&self, p: GroupThreadParams) -> Result<GroupThreadResult, RpcError> {
        let limit = page_limit(p.limit);
        self.with_group(&p.id, |g| {
            g.ensure_messages(&self.home)?;
            let messages = g.messages.as_ref().expect("read above");
            let root = messages
                .iter()
                .find(|m| m.id == p.root && m.thread.is_none())
                .ok_or_else(|| RpcError::invalid_params("that message does not start a thread"))?;
            let before = p.before_seq.unwrap_or(u64::MAX);
            let replies: Vec<&MessageFile> = messages
                .iter()
                .filter(|m| m.thread.as_deref() == Some(root.id.as_str()) && m.seq < before)
                .collect();
            let start = replies.len().saturating_sub(limit.saturating_sub(1));
            let mut shown = vec![self.message(root, messages)];
            shown.extend(replies[start..].iter().map(|m| self.message(m, messages)));
            Ok(GroupThreadResult { messages: shown })
        })
    }

    pub(crate) fn send(&self, p: GroupSendParams) -> Result<GroupSendResult, RpcError> {
        let text = p.text.trim().to_string();
        if text.is_empty() && p.files.is_empty() {
            return Err(RpcError::invalid_params("there is nothing to send"));
        }
        // The group must be there before anything is copied into its folder; the lock below
        // checks again, in case it was deleted meanwhile.
        self.row(&p.id)?;
        // Copying a large file is slow: do it before taking the registry's lock, so other
        // groups and the bots' messages are not held up by it.
        let files = self.ingest_files(&p.id, &p.files)?;
        let message = self.with_group(&p.id, |g| {
            g.ensure_messages(&self.home)?;
            let messages = g.messages.as_ref().expect("read above");
            let reply_to = match &p.reply_to {
                Some(reply) if messages.iter().any(|x| &x.id == reply) => Some(reply.clone()),
                Some(_) => return Err(RpcError::invalid_params("that message is not in the group")),
                None => None,
            };
            let thread = match &p.thread {
                Some(root) if messages.iter().any(|x| &x.id == root && x.thread.is_none()) => Some(root.clone()),
                Some(_) => return Err(RpcError::invalid_params("that message does not start a thread")),
                None => None,
            };
            let mentions = self.mentions(&text, &g.file.members);
            let seq = g.file.next_seq;
            let message = MessageFile {
                id: uuid::Uuid::now_v7().to_string(),
                seq,
                ts: now(),
                from: FromFile::Owner,
                text,
                files,
                mentions,
                reply_to,
                thread,
            };
            let line = serde_json::to_vec(&message).map_err(|e| RpcError::internal(e.to_string()))?;
            append_message(&self.home, &p.id, &line)?;
            g.file.next_seq = seq + 1;
            g.file.summary_list.last = Some(self.last(&message));
            g.messages.as_mut().expect("read above").push(message.clone());
            let shown = self.message(&message, g.messages.as_ref().expect("read above"));
            Ok(shown)
        })?;
        // fsync and the group file are outside the lock too: a slow disk must not stop the
        // other groups.
        self.owner_spoke(&p.id)?;
        self.sync_messages(&p.id)?;
        self.save(&p.id)?;
        self.announce(&[&p.id], Vec::new());
        self.publish(&p.id, &message);
        Ok(GroupSendResult { message })
    }

    /// The local bots of a group, with what a seat needs: id, name, mode.
    pub(crate) fn local_members(&self, id: &str) -> Result<Vec<(String, String, GroupMemberMode)>, RpcError> {
        let members = self
            .with(|groups| groups.get(id).map(|g| g.file.members.clone()))
            .ok_or_else(|| errors::group_not_found(id))?;
        Ok(members
            .into_iter()
            .filter_map(|m| {
                let info = self.bots.member_info(&m.bot_id)?;
                (!info.external).then_some((m.bot_id, info.name, m.mode))
            })
            .collect())
    }

    pub(crate) fn member_session(&self, id: &str, bot_id: &str) -> Result<Option<String>, RpcError> {
        self.with_group(id, |g| Ok(g.file.members.iter().find(|m| m.bot_id == bot_id).and_then(|m| m.session_id.clone())))
    }

    pub(crate) fn set_member_session(&self, id: &str, bot_id: &str, session: String) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            if let Some(member) = g.file.members.iter_mut().find(|m| m.bot_id == bot_id) {
                member.session_id = Some(session);
            }
            Ok(())
        })?;
        self.save(id)
    }

    /// A bot's word in a group: the service got it from its seat session's `send_to_user`.
    pub(crate) fn append_bot(&self, id: &str, bot_id: &str, text: String, files: Vec<GroupFile>, thread: Option<String>, reply_to: Option<String>) -> Result<GroupMessage, RpcError> {
        let message = self.with_group(id, |g| {
            g.ensure_messages(&self.home)?;
            let messages = g.messages.as_ref().expect("read above");
            let reply_to = match reply_to {
                Some(reply) if messages.iter().any(|x| x.id == reply) => Some(reply),
                Some(_) => return Err(RpcError::invalid_params("that message is not in the group")),
                None => None,
            };
            let thread = match thread {
                Some(root) if messages.iter().any(|x| x.id == root && x.thread.is_none()) => Some(root),
                Some(_) => return Err(RpcError::invalid_params("that message does not start a thread")),
                None => None,
            };
            let mentions = self.mentions(&text, &g.file.members);
            let seq = g.file.next_seq;
            let message = MessageFile {
                id: uuid::Uuid::now_v7().to_string(),
                seq,
                ts: now(),
                from: FromFile::Bot { bot_id: bot_id.to_string() },
                text,
                files,
                mentions,
                reply_to,
                thread,
            };
            let line = serde_json::to_vec(&message).map_err(|e| RpcError::internal(e.to_string()))?;
            append_message(&self.home, id, &line)?;
            g.file.next_seq = seq + 1;
            g.file.summary_list.last = Some(self.last(&message));
            g.file.summary_list.unread = g.file.summary_list.unread.saturating_add(1);
            g.messages.as_mut().expect("read above").push(message.clone());
            Ok(self.message(&message, g.messages.as_ref().expect("read above")))
        })?;
        self.sync_messages(id)?;
        self.save(id)?;
        self.announce(&[id], Vec::new());
        self.publish(id, &message);
        Ok(message)
    }

    /// A debug line: who said nothing, for which batch. Never shown in the group.
    pub(crate) fn silence(&self, id: &str, bot_id: &str, from_seq: u64, to_seq: u64, explicit: bool, reason: Option<&str>) -> Result<(), RpcError> {
        let line = serde_json::json!({
            "bot_id": bot_id,
            "from_seq": from_seq,
            "to_seq": to_seq,
            "explicit": explicit,
            "reason": reason,
            "ts": now(),
        });
        let path = self.home.group_dir(id).join("silence.jsonl");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(io_error)?;
        use std::io::Write as _;
        writeln!(file, "{line}").map_err(io_error)
    }

    /// A seat's call waits for the owner: send it to the group page.
    pub(crate) fn on_seat_approval(&self, group: &str, bot: &str, session: &str, call_id: String, name: String, args: Value, summary: String, reason: Option<String>) {
        let cause = self
            .seat_causes
            .lock()
            .get(&(group.to_string(), bot.to_string()))
            .cloned()
            .unwrap_or(GroupApprovalCause {
                kind: GroupCauseKind::Earlier,
                name: None,
                message_id: None,
                text: "此前群里有外部消息".into(),
            });
        self.feed.send(Bytes::from(finx_rpc::notification(
            method::GROUP_APPROVAL,
            &GroupApprovalParams {
                group_id: group.to_string(),
                bot_id: bot.to_string(),
                session_id: session.to_string(),
                call_id,
                name,
                args,
                summary,
                reason,
                cause,
            },
        )));
    }

    /// The owner spoke: fuse 1's "since the owner's last message" count starts again, and an
    /// owner-silence stop is lifted (brief §4.8).
    pub(crate) fn owner_spoke(&self, id: &str) -> Result<(), RpcError> {
        self.consecutive.lock().insert(id.to_string(), 0);
        self.with_group(id, |g| {
            if matches!(g.file.fuse.stopped.as_ref().map(|s| s.reason), Some(GroupStopReason::OwnerSilent)) {
                g.file.fuse.stopped = None;
            }
            Ok(())
        })?;
        self.save(id)
    }

    /// Whether a bot may be given more group messages now: the group is not stopped, and this
    /// bot has not said more than its minute's worth (brief §4.8, fuse 1).
    pub(crate) fn delivery_allowed(&self, id: &str, bot: &str, settings: &GroupsSettings) -> bool {
        let stopped = self.with(|groups| groups.get(id).and_then(|g| g.file.fuse.stopped.clone()));
        if stopped.is_some() {
            return false;
        }
        let minute = chrono::Utc::now().timestamp() / 60;
        let mut minutes = self.bot_minute.lock();
        let entry = minutes.entry((id.to_string(), bot.to_string())).or_insert((minute, 0));
        if entry.0 != minute {
            *entry = (minute, 0);
        }
        entry.1 < settings.bot_per_minute
    }

    /// A bot said a message: count it for its minute and for the owner-silence fuse.
    pub(crate) fn bot_said(&self, id: &str, bot: &str, settings: &GroupsSettings) -> Result<(), RpcError> {
        let minute = chrono::Utc::now().timestamp() / 60;
        {
            let mut minutes = self.bot_minute.lock();
            let entry = minutes.entry((id.to_string(), bot.to_string())).or_insert((minute, 0));
            if entry.0 != minute {
                *entry = (minute, 0);
            }
            entry.1 = entry.1.saturating_add(1);
        }
        let count = {
            let mut counts = self.consecutive.lock();
            let count = counts.entry(id.to_string()).or_insert(0);
            *count = count.saturating_add(1);
            *count
        };
        if count >= settings.bot_run_without_owner {
            self.stop_group(id, GroupStopReason::OwnerSilent, "主人在群里说句话就会继续")?;
        }
        Ok(())
    }

    /// Adds one turn's model usage to the group's day (brief §4.8, fuse 1).
    pub(crate) fn add_tokens(&self, id: &str, tokens: u64, settings: &GroupsSettings) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            g.file.fuse.tokens = g.file.fuse.tokens.saturating_add(tokens);
            Ok(())
        })?;
        self.save(id)?;
        let tokens = self.with(|groups| groups.get(id).map(|g| g.file.fuse.tokens).unwrap_or(0));
        if tokens >= settings.daily_tokens {
            self.stop_group(id, GroupStopReason::DailyTokens, "今天的群额度用完了；主人可以在群设置里点继续")?;
        }
        Ok(())
    }

    /// Fuse 1 stopped the group. A system line says why and how to start again.
    pub(crate) fn stop_group(&self, id: &str, reason: GroupStopReason, detail: impl Into<String>) -> Result<(), RpcError> {
        let detail = detail.into();
        let already = self.with_group(id, |g| {
            let already = g.file.fuse.stopped.as_ref().is_some_and(|s| s.reason == reason);
            if !already {
                g.file.fuse.stopped = Some(GroupStop {
                    reason,
                    bot_id: None,
                    detail: detail.clone(),
                });
            }
            Ok(already)
        })?;
        self.save(id)?;
        if !already {
            let _ = self.system(id, format!("群暂停了：{detail}"));
        }
        Ok(())
    }

    /// A line the group writes about itself.
    pub(crate) fn system(&self, id: &str, text: impl Into<String>) -> Result<GroupMessage, RpcError> {
        let text = text.into();
        let message = self.with_group(id, |g| {
            g.ensure_messages(&self.home)?;
            let seq = g.file.next_seq;
            let message = MessageFile {
                id: uuid::Uuid::now_v7().to_string(),
                seq,
                ts: now(),
                from: FromFile::System,
                text,
                files: Vec::new(),
                mentions: Vec::new(),
                reply_to: None,
                thread: None,
            };
            let line = serde_json::to_vec(&message).map_err(|e| RpcError::internal(e.to_string()))?;
            append_message(&self.home, id, &line)?;
            g.file.next_seq = seq + 1;
            g.file.summary_list.last = Some(self.last(&message));
            g.messages.as_mut().expect("read above").push(message.clone());
            Ok(self.message(&message, g.messages.as_ref().expect("read above")))
        })?;
        self.sync_messages(id)?;
        self.save(id)?;
        self.announce(&[id], Vec::new());
        self.publish(id, &message);
        Ok(message)
    }

    pub(crate) fn read(&self, id: &str) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            g.file.summary_list.unread = 0;
            Ok(())
        })?;
        self.save(id)?;
        self.announce(&[id], Vec::new());
        Ok(())
    }

    /// Flushes a group's appended messages after the registry lock is released.
    fn sync_messages(&self, id: &str) -> Result<(), RpcError> {
        let path = self.home.group_dir(id).join("messages.jsonl");
        let mut options = std::fs::OpenOptions::new();
        options.append(true);
        let file = options.open(&path).map_err(io_error)?;
        file.sync_all().map_err(io_error)
    }

    fn ingest_files(&self, group_id: &str, paths: &[String]) -> Result<Vec<GroupFile>, RpcError> {
        let dir = self.home.group_files_dir(group_id);
        private_dir(&dir).map_err(io_error)?;
        let mut out = Vec::new();
        for raw in paths {
            let source = PathBuf::from(raw);
            if !source.is_absolute() {
                return Err(RpcError::invalid_params(format!("{raw}: a file must be given by its absolute path")));
            }
            let meta = std::fs::metadata(&source).map_err(|e| RpcError::invalid_params(format!("{}: {e}", source.display())))?;
            if !meta.is_file() {
                return Err(RpcError::invalid_params(format!("{}: not a file", source.display())));
            }
            let name = clean_file_name(source.file_name().and_then(|n| n.to_str()).unwrap_or("file"));
            let target = unique_file(&dir, &name);
            let target_name = target.file_name().and_then(|n| n.to_str()).unwrap_or(&name).to_string();
            if std::fs::canonicalize(&source).ok() != std::fs::canonicalize(&target).ok() {
                std::fs::copy(&source, &target).map_err(io_error)?;
            }
            let size = std::fs::metadata(&target).map_err(io_error)?.len();
            out.push(GroupFile {
                path: format!("files/{target_name}"),
                name: target_name.clone(),
                size,
                media_type: media_type(&target_name).map(str::to_string),
            });
        }
        Ok(out)
    }

    fn mentions(&self, text: &str, members: &[MemberFile]) -> Vec<String> {
        let mut names: Vec<(&str, String)> = members
            .iter()
            .filter_map(|m| self.bots.member_info(&m.bot_id).map(|i| (m.bot_id.as_str(), i.name)))
            .collect();
        // Longest first: @Alice must not win over @AliceZhang.
        names.sort_by_key(|(_, name)| std::cmp::Reverse(name.chars().count()));
        let chars: Vec<char> = text.chars().collect();
        let mut out = Vec::new();
        for i in 0..chars.len() {
            if chars[i] != '@' {
                continue;
            }
            let rest: String = chars[i + 1..].iter().collect();
            for (id, name) in &names {
                if !rest.starts_with(name) {
                    continue;
                }
                let after = rest[name.len()..].chars().next();
                if after.is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '-')) {
                    if !out.iter().any(|x: &String| x == id) {
                        out.push(id.to_string());
                    }
                    break;
                }
            }
        }
        out
    }

    fn speaker(&self, from: &FromFile) -> GroupSpeaker {
        match from {
            FromFile::Owner => GroupSpeaker::Owner,
            FromFile::System => GroupSpeaker::System,
            FromFile::Bot { bot_id } => match self.bots.member_info(bot_id) {
                Some(info) => GroupSpeaker::Bot {
                    bot_id: bot_id.clone(),
                    name: info.name,
                    external: info.external,
                },
                None => GroupSpeaker::Bot {
                    bot_id: bot_id.clone(),
                    name: bot_id.clone(),
                    external: false,
                },
            },
        }
    }

    fn message(&self, m: &MessageFile, all: &[MessageFile]) -> GroupMessage {
        let reply_preview = m.reply_to.as_ref().and_then(|id| all.iter().find(|x| &x.id == id)).map(|x| GroupQuote {
            id: x.id.clone(),
            from: self.speaker(&x.from),
            text: x.text.clone(),
        });
        GroupMessage {
            id: m.id.clone(),
            seq: m.seq,
            ts: m.ts.clone(),
            from: self.speaker(&m.from),
            text: m.text.clone(),
            files: m.files.clone(),
            mentions: m.mentions.clone(),
            reply_to: m.reply_to.clone(),
            thread: m.thread.clone(),
            reply_preview,
        }
    }

    fn last(&self, m: &MessageFile) -> GroupLast {
        let images = m.files.iter().filter(|f| is_image(f)).count() as u32;
        let file = m.files.iter().find(|f| !is_image(f)).map(|f| f.name.clone());
        GroupLast {
            from: self.speaker(&m.from),
            text: m.text.chars().take(LAST_TEXT_MAX).collect(),
            images,
            file,
            ts: m.ts.clone(),
        }
    }

    /// Whether an external member takes part in a thread: it spoke there, someone mentioned
    /// it there, or the thread was opened by a message that mentioned it (brief §4.7).
    pub(crate) fn peer_in_thread(&self, id: &str, bot_id: &str, root: &str) -> Result<bool, RpcError> {
        self.with_group(id, |g| {
            g.ensure_messages(&self.home)?;
            let messages = g.messages.as_ref().expect("read above");
            let root_message = messages.iter().find(|m| m.id == root && m.thread.is_none());
            if root_message.is_some_and(|m| m.mentions.iter().any(|id| id == bot_id)) {
                return Ok(true);
            }
            Ok(messages.iter().filter(|m| m.thread.as_deref() == Some(root)).any(|m| {
                m.mentions.iter().any(|id| id == bot_id)
                    || matches!(&m.from, FromFile::Bot { bot_id: from } if from == bot_id)
            }))
        })
    }

    /// The external members of a group, with what a batch needs (brief §4.7).
    pub(crate) fn external_members(&self, id: &str) -> Result<Vec<ExternalMember>, RpcError> {
        let (members, peers) = self
            .with(|groups| groups.get(id).map(|g| (g.file.members.clone(), g.file.peers.clone())))
            .ok_or_else(|| errors::group_not_found(id))?;
        Ok(members
            .into_iter()
            .filter_map(|m| {
                let info = self.bots.member_info(&m.bot_id)?;
                if !info.external {
                    return None;
                }
                Some(ExternalMember {
                    stateless: peers.get(&m.bot_id).is_some_and(|peer| peer.stateless),
                    bot_id: m.bot_id,
                    name: info.name,
                    mode: m.mode,
                    history: m.history,
                    joined_seq: m.joined_seq,
                })
            })
            .collect())
    }

    /// One external member's contexts and read positions.
    pub(crate) fn peer_state(&self, id: &str, bot_id: &str) -> Result<PeerState, RpcError> {
        let peer = self
            .with(|groups| groups.get(id).map(|g| g.file.peers.get(bot_id).cloned()))
            .ok_or_else(|| errors::group_not_found(id))?;
        Ok(match peer {
            Some(peer) => PeerState {
                stateless: peer.stateless,
                members_sent: peer.members_sent,
                contexts: peer
                    .contexts
                    .into_iter()
                    .map(|(stream, context)| {
                        (
                            stream,
                            PeerContext {
                                context_id: context.context_id,
                                sent_seq: context.sent_seq,
                            },
                        )
                    })
                    .collect(),
            },
            None => PeerState::default(),
        })
    }

    /// Records the context the other side gave for a stream.
    pub(crate) fn set_peer_context(&self, id: &str, bot_id: &str, stream: &str, context_id: &str) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            let peer = g.file.peers.entry(bot_id.to_string()).or_default();
            let context = peer.contexts.entry(stream.to_string()).or_insert(ContextFile {
                context_id: String::new(),
                sent_seq: 0,
            });
            context.context_id = context_id.to_string();
            Ok(())
        })?;
        self.save(id)
    }

    /// Moves a stream's read position, after the other side accepted the batch (brief §4.7).
    pub(crate) fn advance_peer_sent(&self, id: &str, bot_id: &str, stream: &str, sent_seq: u64) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            let peer = g.file.peers.entry(bot_id.to_string()).or_default();
            let context = peer.contexts.entry(stream.to_string()).or_insert(ContextFile {
                context_id: String::new(),
                sent_seq: 0,
            });
            context.sent_seq = context.sent_seq.max(sent_seq);
            Ok(())
        })?;
        self.save(id)
    }

    pub(crate) fn mark_peer_members_sent(&self, id: &str, bot_id: &str) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            g.file.peers.entry(bot_id.to_string()).or_default().members_sent = true;
            Ok(())
        })?;
        self.save(id)
    }

    /// A member joined or left: every external member hears the new list next time.
    pub(crate) fn reset_peer_members_seen(&self, id: &str) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            for peer in g.file.peers.values_mut() {
                peer.members_sent = false;
            }
            Ok(())
        })?;
        self.save(id)
    }

    pub(crate) fn set_peer_stateless(&self, id: &str, bot_id: &str, stateless: bool) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            g.file.peers.entry(bot_id.to_string()).or_default().stateless = stateless;
            Ok(())
        })?;
        self.save(id)
    }

    /// Every message in the group, oldest first, as the client sees it.
    pub(crate) fn messages(&self, id: &str) -> Result<Vec<GroupMessage>, RpcError> {
        self.with_group(id, |g| {
            g.ensure_messages(&self.home)?;
            let all = g.messages.as_ref().expect("read above");
            Ok(all.iter().map(|m| self.message(m, all)).collect())
        })
    }

    /// The rolling summary and the sequence it covers.
    pub(crate) fn rolling_summary(&self, id: &str) -> Result<(u64, String), RpcError> {
        self.with_group(id, |g| Ok((g.file.summary.upto_seq, g.file.summary.text.clone())))
    }

    pub(crate) fn set_summary(&self, id: &str, upto_seq: u64, text: String) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            g.file.summary.upto_seq = upto_seq;
            g.file.summary.text = text;
            Ok(())
        })?;
        self.save(id)
    }

    /// A group's day gained one call to another subject's bot (brief §4.8, fuse 1).
    pub(crate) fn add_peer_call(&self, id: &str, settings: &GroupsSettings) -> Result<(), RpcError> {
        self.with_group(id, |g| {
            if day(&g.file.fuse) != today() {
                g.file.fuse.day = today();
                g.file.fuse.peer_calls = 0;
                g.file.fuse.tokens = 0;
            }
            g.file.fuse.peer_calls = g.file.fuse.peer_calls.saturating_add(1);
            Ok(())
        })?;
        self.save(id)?;
        let calls = self.with(|groups| groups.get(id).map(|g| g.file.fuse.peer_calls).unwrap_or(0));
        if calls >= settings.daily_peer_calls {
            self.stop_group(id, GroupStopReason::DailyPeerCalls, "今天给外部 Bot 的调用额度用完了；主人可以在群设置里点继续")?;
        }
        Ok(())
    }

    /// Another subject's bot said something: its words go into the group like a local bot's,
    /// with the files it gave written into the group's folder (brief §4.7).
    pub(crate) fn append_external(
        &self,
        id: &str,
        bot_id: &str,
        text: String,
        files: Vec<PeerIncomingFile>,
        thread: Option<String>,
        reply_to: Option<String>,
    ) -> Result<GroupMessage, RpcError> {
        let dir = self.home.group_files_dir(id);
        private_dir(&dir).map_err(io_error)?;
        let mut written = Vec::new();
        for file in files {
            let name = clean_file_name(&file.name);
            let target = unique_file(&dir, &name);
            let target_name = target.file_name().and_then(|n| n.to_str()).unwrap_or(&name).to_string();
            std::fs::write(&target, &file.bytes).map_err(io_error)?;
            written.push(GroupFile {
                path: format!("files/{target_name}"),
                name: target_name.clone(),
                size: file.bytes.len() as u64,
                media_type: file.media_type.or_else(|| media_type(&target_name).map(str::to_string)),
            });
        }
        self.append_bot(id, bot_id, text, written, thread, reply_to)
    }
}

fn batch_message(message: GroupMessage) -> finx_core::GroupBatchMessage {
    finx_core::GroupBatchMessage {
        id: message.id.clone(),
        seq: message.seq,
        from: match message.from {
            GroupSpeaker::Owner => finx_core::GroupBatchSpeaker::Owner,
            GroupSpeaker::Bot { name, external, .. } => finx_core::GroupBatchSpeaker::Bot { name, external },
            GroupSpeaker::System => finx_core::GroupBatchSpeaker::System,
        },
        text: message.text,
        files: message
            .files
            .into_iter()
            .map(|f| finx_core::GroupBatchFile {
                path: f.path,
                name: f.name,
                size: f.size,
            })
            .collect(),
        reply_to: message.reply_to,
        thread: message.thread,
    }
}

fn page_limit(limit: Option<u32>) -> usize {
    (limit.map(|n| n as usize).unwrap_or(PAGE)).clamp(1, PAGE_MAX)
}

fn clean_name(raw: &str) -> Result<String, RpcError> {
    let name = raw.trim();
    let len = name.chars().count();
    if len == 0 || len > NAME_MAX {
        return Err(RpcError::invalid_params(format!("a group's name must be 1 to {NAME_MAX} characters")));
    }
    Ok(name.to_string())
}

fn clean_file_name(raw: &str) -> String {
    // Only the last path segment: a name from elsewhere never writes outside the group's folder.
    let raw = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let cleaned = if cleaned.is_empty() { "file" } else { cleaned };
    cleaned.chars().take(120).collect()
}

fn media_type(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => return None,
    })
}

fn is_image(file: &GroupFile) -> bool {
    file.media_type.as_deref().is_some_and(|m| m.starts_with("image/"))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn day(fuse: &FuseFile) -> String {
    if fuse.day.is_empty() { today() } else { fuse.day.clone() }
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn io_error(e: std::io::Error) -> RpcError {
    RpcError::internal(e.to_string())
}

fn make_dirs(home: &FinxHome, id: &str) -> Result<(), RpcError> {
    private_dir(&home.group_dir(id)).map_err(io_error)?;
    private_dir(&home.group_files_dir(id)).map_err(io_error)?;
    Ok(())
}

fn touch_messages(home: &FinxHome, id: &str) -> Result<(), RpcError> {
    let path = home.group_dir(id).join("messages.jsonl");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path).map_err(io_error)?;
    Ok(())
}

fn append_message(home: &FinxHome, id: &str, line: &[u8]) -> Result<(), RpcError> {
    let path = home.group_dir(id).join("messages.jsonl");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(io_error)?;
    file.write_all(line).map_err(io_error)?;
    file.write_all(b"\n").map_err(io_error)?;
    Ok(())
}

/// The `seq` of the last line of `messages.jsonl`, if it can be read: a crash may leave
/// `group.json`'s `next_seq` behind the messages it already has.
fn last_seq(path: &Path) -> Option<u64> {
    const TAIL: u64 = 4 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines().rev().filter(|line| !line.trim().is_empty()) {
        if let Ok(message) = serde_json::from_str::<MessageFile>(line) {
            return Some(message.seq);
        }
    }
    if start > 0 {
        // A single message larger than the tail: read the file whole rather than miss it.
        let text = std::fs::read_to_string(path).ok()?;
        for line in text.lines().rev().filter(|line| !line.trim().is_empty()) {
            if let Ok(message) = serde_json::from_str::<MessageFile>(line) {
                return Some(message.seq);
            }
        }
    }
    None
}

fn read_messages(dir: &Path) -> Result<Vec<MessageFile>, RpcError> {
    let path = dir.join("messages.jsonl");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_error(e)),
    };
    let mut out = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<MessageFile>(line) {
            Ok(message) => out.push(message),
            Err(err) => tracing::warn!(path = %path.display(), "cannot read a group message: {err}"),
        }
    }
    out.sort_by_key(|m| m.seq);
    Ok(out)
}

fn read_all(home: &FinxHome) -> BTreeMap<String, Group> {
    let mut out = BTreeMap::new();
    let Ok(dir) = std::fs::read_dir(home.groups_dir()) else {
        return out;
    };
    for entry in dir.flatten() {
        let Ok(bytes) = std::fs::read(entry.path().join("group.json")) else {
            continue;
        };
        match serde_json::from_slice::<GroupData>(&bytes) {
            Ok(mut file) => {
                if file.fuse.day.is_empty() {
                    file.fuse.day = today();
                }
                // `next_seq` is written after the message it counts. A crash in between leaves
                // it behind, so the next message would reuse a seq: take the larger one.
                if let Some(seq) = last_seq(&home.group_dir(&file.id).join("messages.jsonl")) {
                    file.next_seq = file.next_seq.max(seq + 1);
                }
                out.insert(file.id.clone(), Group { file, messages: None });
            }
            Err(err) => tracing::warn!(path = %entry.path().display(), "cannot read a group: {err}"),
        }
    }
    out
}

fn write_file(home: &FinxHome, file: &GroupData) -> Result<(), RpcError> {
    private_dir(&home.group_dir(&file.id)).map_err(io_error)?;
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| RpcError::internal(e.to_string()))?;
    replace_file(&home.group_dir(&file.id).join("group.json"), &bytes).map_err(io_error)
}

fn unique_file(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem}-{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}", uuid::Uuid::now_v7()))
}

fn unique_dir(parent: &Path, id: &str) -> PathBuf {
    let candidate = parent.join(id);
    if !candidate.exists() {
        return candidate;
    }
    parent.join(format!("{id}-{}", uuid::Uuid::now_v7()))
}

impl Server {
    pub(crate) fn groups(&self) -> &Arc<Registry> {
        &self.0.groups
    }

    /// Every local member has a seat session: started when it has none, kept loaded while the
    /// service runs.
    pub(crate) async fn ensure_group_seats(&self, id: &str) -> Result<(), RpcError> {
        let _one = self.0.group_seating.lock().await;
        for (bot, name, _mode) in self.groups().local_members(id)? {
            if self.groups().member_session(id, &bot)?.is_some() {
                continue;
            }
            let session = self.start_group_seat(id, &bot, name).await?;
            self.groups().set_member_session(id, &bot, session)?;
        }
        Ok(())
    }

    async fn start_group_seat(&self, group_id: &str, bot_id: &str, bot_name: String) -> Result<String, RpcError> {
        self.make_room().await?;
        let group_name = self.groups().row(group_id)?.name;
        let folder = self.0.home.group_files_dir(group_id);
        std::fs::create_dir_all(&folder).map_err(|e| RpcError::internal(format!("cannot create {}: {e}", folder.display())))?;
        let workspace = Workspace::open(&self.0.home, &folder, &self.0.overrides).map_err(errors::from_runtime)?;
        let (model, thinking, permission) = self.bots().seat_settings(bot_id).unwrap_or((None, None, None));
        let model = self.session_model(model, workspace.config.model.clone()).await?;
        let store: Arc<dyn finx_core::SessionStore> = self.0.store.clone();
        let mut deps = workspace.kernel_deps(self.0.llm.clone(), store, &[]).map_err(errors::from_runtime)?;
        // A seat has no browser, no connectors and no MCP (brief §4.3).
        deps.browser_pool = None;
        deps.docs = Some(self.0.docs.clone());
        deps.decks = Some(self.0.decks.clone());
        deps.words = Some(self.0.words.clone());
        deps.mcp_servers = Vec::new();
        deps.routines = None;
        let options = StartOptions {
            model,
            thinking: thinking.unwrap_or(workspace.config.thinking),
            permission_mode: permission.unwrap_or(workspace.config.permission_mode),
            cwd: workspace.cwd.clone(),
            home: self.0.home.clone(),
            project_root: None,
            trusted: workspace.trusted,
            config: Arc::new(workspace.config),
            interactive_approvals: true,
            bot: Some(BotIdentity {
                id: bot_id.to_string(),
                name: bot_name,
            }),
            peer: None,
            group: Some(GroupRef {
                id: group_id.to_string(),
                name: group_name,
            }),
        };
        let kernel = finx_core::Kernel::start(options, deps).await.map_err(|e| errors::from_kernel(e, "new"))?;
        let now = now();
        let base = SummaryBase {
            created_at: now.clone(),
            preview: None,
            updated_at: now,
            no_project: true,
        };
        Ok(self.register_seat(kernel, base, group_id.to_string(), bot_id.to_string()))
    }

    fn register_seat(&self, kernel: finx_core::Kernel, base: SummaryBase, group_id: String, bot_id: String) -> String {
        let id = kernel.session_id().to_string();
        let server = Arc::downgrade(&self.0);
        let exit_id = id.clone();
        let on_exit = Box::new(move |_last: finx_protocol::api::SessionSummary| {
            if let Some(inner) = server.upgrade() {
                inner.sessions.lock().remove(&exit_id);
                inner.closed_sessions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
        let listing = Listing::Group {
            group_id,
            bot_id,
            groups: self.0.groups.clone(),
            events: parking_lot::Mutex::default(),
        };
        let mut sessions = self.0.sessions.lock();
        let handle = crate::hub::spawn(kernel, Vec::new(), self.idle_after(), None, listing, base, on_exit);
        sessions.insert(id.clone(), handle);
        id
    }

    /// Sends a message to the seats that should hear it now, or after their quiet period.
    pub(crate) async fn pass_on(&self, group_id: &str, sender: Option<&str>, message: GroupMessage) {
        let Ok(members) = self.groups().local_members(group_id) else {
            return;
        };
        let settings = self.0.group_settings.clone();
        for (bot, _name, mode) in members {
            if Some(bot.as_str()) == sender {
                continue;
            }
            if !self.groups().delivery_allowed(group_id, &bot, &settings) {
                continue;
            }
            let mentioned = message.mentions.iter().any(|id| id == &bot);
            let in_thread = message.thread.is_some();
            if mode == GroupMemberMode::Mentions && !mentioned {
                continue;
            }
            if mentioned || in_thread {
                let mut batch = self.0.group_pending.lock().remove(&(group_id.to_string(), bot.clone())).unwrap_or_default();
                batch.push(message.clone());
                let _ = self.deliver_to_seat(group_id, &bot, batch).await;
            } else {
                let key = (group_id.to_string(), bot.clone());
                let (first, enough) = {
                    let mut pending = self.0.group_pending.lock();
                    let entry = pending.entry(key.clone()).or_default();
                    let first = entry.is_empty();
                    entry.push(message.clone());
                    (first, entry.len() >= settings.lazy_count.max(1) as usize)
                };
                if enough {
                    let batch = self.0.group_pending.lock().remove(&key).unwrap_or_default();
                    let _ = self.deliver_to_seat(group_id, &bot, batch).await;
                } else if first {
                    let server = self.handle();
                    let group = group_id.to_string();
                    let bot = bot.clone();
                    let lazy = mode == GroupMemberMode::Lazy;
                    tokio::spawn(async move {
                        // The quiet period, and the longest wait from the first message.
                        let quiet = std::time::Duration::from_secs(if lazy { settings.lazy_secs.max(1) } else { settings.quiet_secs.max(1) });
                        let max = std::time::Duration::from_secs(if lazy { settings.lazy_secs.max(1) } else { settings.max_wait_secs.max(1) });
                        let start = std::time::Instant::now();
                        loop {
                            tokio::time::sleep(quiet).await;
                            let more = server
                                .0
                                .group_pending
                                .lock()
                                .get(&(group.clone(), bot.clone()))
                                .is_some_and(|pending| !pending.is_empty());
                            if !more || start.elapsed() >= max {
                                break;
                            }
                        }
                        let messages = server.0.group_pending.lock().remove(&(group.clone(), bot.clone())).unwrap_or_default();
                        if !messages.is_empty() {
                            let _ = server.deliver_to_seat(&group, &bot, messages).await;
                        }
                    });
                }
            }
        }
        // External members have no seat: the service talks to them itself (brief §4.7).
        let external_members = self.groups().external_members(group_id);
        if let Ok(external) = external_members {
            for member in external {
                if Some(member.bot_id.as_str()) == sender {
                    continue;
                }
                self.queue_external(group_id, &member, message.clone()).await;
            }
        }
    }

    async fn deliver_to_seat(&self, group_id: &str, bot_id: &str, messages: Vec<GroupMessage>) -> Result<(), RpcError> {
        if messages.is_empty() {
            return Ok(());
        }
        let Some(session) = self.groups().member_session(group_id, bot_id)? else {
            return Ok(());
        };
        let Some(hub) = self.hub(&session) else {
            return Ok(());
        };
        let group = self.groups().row(group_id)?;
        let members: Vec<finx_core::GroupBatchMember> = group
            .members
            .iter()
            .map(|m| finx_core::GroupBatchMember {
                name: m.name.clone(),
                owner: false,
                external: m.external,
                external_host: None,
                you: m.bot_id == bot_id,
            })
            .collect();
        let mut members = members;
        members.insert(
            0,
            finx_core::GroupBatchMember {
                name: "Owner".into(),
                owner: true,
                external: false,
                external_host: None,
                you: false,
            },
        );
        let cause = messages.iter().find(|m| matches!(m.from, GroupSpeaker::Bot { external: true, .. })).map(|m| {
            let name = match &m.from { GroupSpeaker::Bot { name, .. } => name.clone(), _ => "外部成员".into() };
            GroupApprovalCause {
                kind: GroupCauseKind::Direct,
                name: Some(name),
                message_id: Some(m.id.clone()),
                text: m.text.chars().take(200).collect(),
            }
        });
        if let Some(cause) = cause {
            self.groups().seat_causes.lock().insert((group_id.to_string(), bot_id.to_string()), cause);
        }
        let mentioned = messages.iter().any(|m| m.mentions.iter().any(|id| id == bot_id));
        let thread = messages
            .iter()
            .find(|m| m.thread.is_none() && m.mentions.iter().any(|id| id == bot_id))
            .map(|m| m.id.clone())
            .or_else(|| messages.iter().find_map(|m| m.thread.clone()));
        let from = messages.first().map(|m| m.seq).unwrap_or(0);
        let to = messages.last().map(|m| m.seq).unwrap_or(0);
        self.groups().set_seat_turn(group_id, bot_id, thread, from, to);
        let batch = finx_core::GroupBatch {
            group: GroupRef {
                id: group.id.clone(),
                name: group.name.clone(),
            },
            members,
            members_changed: true,
            note: group.note.clone(),
            note_changed: false,
            mentioned,
            messages: messages.into_iter().map(batch_message).collect(),
            while_thinking: hub.shared.busy.load(std::sync::atomic::Ordering::Relaxed),
        };
        hub.send(HubCmd::Group(batch)).await
    }

    /// A seat sent a word: add it to the group and pass it on.
    pub(crate) fn group_seat_spoke(&self, group_id: &str, bot_id: &str, args: &Value, details: Option<&Value>) {
        let text = args.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
        if args.get("type").and_then(Value::as_str) == Some("question") {
            return;
        }
        let mut files = Vec::new();
        if let Some(list) = args.get("files").and_then(Value::as_array) {
            let sizes: HashMap<String, u64> = details
                .and_then(|d| d.get("files"))
                .and_then(Value::as_array)
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|f| Some((f.get("path")?.as_str()?.to_string(), f.get("size")?.as_u64()?)))
                        .collect()
                })
                .unwrap_or_default();
            for file in list {
                let Some(raw) = file.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let name = Path::new(raw).file_name().and_then(|n| n.to_str()).unwrap_or(raw).to_string();
                let path = format!("files/{name}");
                files.push(GroupFile {
                    size: sizes.get(raw).copied().unwrap_or(0),
                    name,
                    path,
                    media_type: None,
                });
            }
        }
        let turn = self.groups().seat_turn_for(group_id, bot_id);
        let thread = args
            .get("thread_on")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(turn);
        let reply = args.get("reply_to").and_then(Value::as_str).map(str::to_string);
        let Ok(message) = self.groups().append_bot(group_id, bot_id, text, files, thread, reply) else {
            return;
        };
        let _ = self.groups().bot_said(group_id, bot_id, &self.0.group_settings);
        let server = self.handle();
        let group = group_id.to_string();
        let bot = bot_id.to_string();
        tokio::spawn(async move {
            server.pass_on(&group, Some(&bot), message).await;
        });
    }

    pub(crate) fn groups_subscribe(&self, conn: &ConnHandle, respond: impl FnOnce(Result<GroupsResult, RpcError>) -> Vec<u8>) {
        let registry = self.groups();
        registry.watch(conn);
        registry.start(
            conn,
            respond(Ok(GroupsResult {
                groups: registry.rows(|_| true),
            })),
        );
    }

    pub(crate) fn groups_unsubscribe(&self, conn: &ConnHandle) {
        self.groups().stop_watching(conn.id);
    }

    pub(crate) async fn groups_create(&self, p: GroupCreateParams) -> Result<GroupSummary, RpcError> {
        let row = self.groups().create(p)?;
        self.ensure_group_seats(&row.id).await?;
        for member in self.groups().external_members(&row.id)? {
            // A new external member's stateless probe (brief §4.7).
            self.probe_stateless(&row.id, &member.bot_id).await;
        }
        Ok(row)
    }

    pub(crate) fn groups_update(&self, p: GroupUpdateParams) -> Result<(), RpcError> {
        self.groups().update(p)
    }

    pub(crate) fn groups_delete(&self, p: GroupIdParams) -> Result<(), RpcError> {
        self.groups().delete(&p.id)
    }

    pub(crate) async fn groups_add_member(&self, p: GroupAddMemberParams) -> Result<GroupSummary, RpcError> {
        let bot_id = p.bot_id.clone();
        let row = self.groups().add_member(p)?;
        self.ensure_group_seats(&row.id).await?;
        self.groups().reset_peer_members_seen(&row.id)?;
        if self.groups().external_members(&row.id)?.iter().any(|m| m.bot_id == bot_id) {
            self.probe_stateless(&row.id, &bot_id).await;
            // The new member's history choice may need the rolling summary: make it now.
            let _ = self.maybe_summarize(&row.id).await;
        }
        Ok(row)
    }

    pub(crate) fn groups_remove_member(&self, p: GroupRemoveMemberParams) -> Result<(), RpcError> {
        let id = p.id.clone();
        self.groups().remove_member(p)?;
        self.groups().reset_peer_members_seen(&id)
    }

    pub(crate) fn groups_set_member(&self, p: GroupSetMemberParams) -> Result<(), RpcError> {
        self.groups().set_member(p)
    }

    pub(crate) fn groups_open(&self, p: GroupOpenParams) -> Result<GroupOpenResult, RpcError> {
        let result = self.groups().open(p)?;
        let server = self.handle();
        let id = result.group.id.clone();
        tokio::spawn(async move {
            let _ = server.ensure_group_seats(&id).await;
        });
        Ok(result)
    }

    pub(crate) fn groups_thread(&self, p: GroupThreadParams) -> Result<GroupThreadResult, RpcError> {
        self.groups().thread(p)
    }

    pub(crate) fn groups_send(&self, p: GroupSendParams) -> Result<GroupSendResult, RpcError> {
        let id = p.id.clone();
        let result = self.groups().send(p)?;
        let message = result.message.clone();
        let server = self.handle();
        let group = id.clone();
        tokio::spawn(async move {
            let _ = server.ensure_group_seats(&group).await;
            server.pass_on(&group, None, message).await;
            // The rolling summary is for the next external member; never in the way of a send.
            let _ = server.maybe_summarize(&group).await;
        });
        Ok(result)
    }

    pub(crate) fn groups_read(&self, p: GroupIdParams) -> Result<(), RpcError> {
        self.groups().read(&p.id)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use finx_protocol::api::error_code;

    fn setup(external: bool) -> (tempfile::TempDir, FinxHome, Arc<bots::Registry>, Registry) {
        let dir = tempfile::tempdir().unwrap();
        let home = FinxHome::new(dir.path().canonicalize().unwrap().join("home"));
        home.ensure().unwrap();
        let bots = Arc::new(bots::Registry::new(home.clone()));
        bots.add_named_for_test("bot-a", "Alice");
        bots.add_named_for_test("bot-b", "Bob");
        let groups = Registry::new(home.clone(), bots.clone(), external, GroupsSettings::default());
        (dir, home, bots, groups)
    }

    fn member(id: &str) -> GroupMemberInput {
        GroupMemberInput {
            bot_id: id.to_string(),
            mode: None,
            history: None,
        }
    }

    fn group(groups: &Registry) -> GroupSummary {
        groups
            .create(GroupCreateParams {
                name: "装修群".into(),
                note: Some("看报价".into()),
                members: vec![member("bot-a"), member("bot-b")],
            })
            .unwrap()
    }

    fn send(groups: &Registry, id: &str, text: &str) -> GroupMessage {
        groups
            .send(GroupSendParams {
                id: id.to_string(),
                text: text.to_string(),
                files: Vec::new(),
                reply_to: None,
                thread: None,
            })
            .unwrap()
            .message
    }

    #[test]
    fn creates_sends_and_reads_back() {
        let (_dir, home, bots, groups) = setup(true);
        let row = group(&groups);
        assert_eq!(row.name, "装修群");
        assert_eq!(row.note.as_deref(), Some("看报价"));
        assert_eq!(row.members.len(), 2);
        assert!(!row.external);

        let first = send(&groups, &row.id, "@Alice 帮我看看这个报价");
        assert_eq!(first.seq, 0);
        assert_eq!(first.mentions, vec!["bot-a"]);
        let second = send(&groups, &row.id, "谢谢");
        assert_eq!(second.seq, 1);

        let open = groups.open(GroupOpenParams { id: row.id.clone(), before_seq: None, limit: None }).unwrap();
        assert_eq!(open.messages.len(), 2);
        assert_eq!(open.messages[0].text, "@Alice 帮我看看这个报价");
        assert_eq!(open.group.last.as_ref().unwrap().text, "谢谢");
        assert_eq!(open.group.unread, 0);

        let reloaded = Registry::new(home, bots, true, GroupsSettings::default());
        let again = reloaded.open(GroupOpenParams { id: row.id.clone(), before_seq: None, limit: None }).unwrap();
        assert_eq!(again.messages, open.messages);
        let next = send(&reloaded, &row.id, "第三句");
        assert_eq!(next.seq, 2);
    }

    #[test]
    fn threads_and_quotes() {
        let (_dir, _home, _bots, groups) = setup(true);
        let row = group(&groups);
        let root = send(&groups, &row.id, "这是一个话题的起点");
        let reply = groups
            .send(GroupSendParams {
                id: row.id.clone(),
                text: "在话题里回复".into(),
                files: Vec::new(),
                reply_to: None,
                thread: Some(root.id.clone()),
            })
            .unwrap()
            .message;
        assert_eq!(reply.thread.as_deref(), Some(root.id.as_str()));
        let quoted = groups
            .send(GroupSendParams {
                id: row.id.clone(),
                text: "引用一下".into(),
                files: Vec::new(),
                reply_to: Some(root.id.clone()),
                thread: None,
            })
            .unwrap()
            .message;
        assert_eq!(quoted.reply_to.as_deref(), Some(root.id.as_str()));
        assert_eq!(quoted.reply_preview.as_ref().unwrap().text, "这是一个话题的起点");

        let open = groups.open(GroupOpenParams { id: row.id.clone(), before_seq: None, limit: None }).unwrap();
        assert_eq!(open.messages.len(), 2, "the thread reply is not in the main flow");
        assert_eq!(open.threads.len(), 1);
        assert_eq!(open.threads[0].root, root.id);
        assert_eq!(open.threads[0].replies, 1);

        let thread = groups.thread(GroupThreadParams { id: row.id, root: root.id, before_seq: None, limit: None }).unwrap();
        assert_eq!(thread.messages.len(), 2);
        assert_eq!(thread.messages[0].text, "这是一个话题的起点");
        assert_eq!(thread.messages[1].text, "在话题里回复");
    }

    #[test]
    fn files_members_and_delete() {
        let (dir, home, _bots, groups) = setup(true);
        let row = group(&groups);
        let source = dir.path().join("合同.pdf");
        std::fs::write(&source, b"%PDF-1.4").unwrap();
        let message = groups
            .send(GroupSendParams {
                id: row.id.clone(),
                text: "合同在这里".into(),
                files: vec![source.to_string_lossy().to_string()],
                reply_to: None,
                thread: None,
            })
            .unwrap()
            .message;
        assert_eq!(message.files.len(), 1);
        assert_eq!(message.files[0].name, "合同.pdf");
        assert_eq!(message.files[0].media_type.as_deref(), Some("application/pdf"));
        assert!(home.group_files_dir(&row.id).join("合同.pdf").exists());

        let added = groups
            .add_member(GroupAddMemberParams {
                id: row.id.clone(),
                bot_id: "bot-c".into(),
                mode: Some(GroupMemberMode::Lazy),
                history: None,
            });
        assert!(added.is_err(), "an unknown bot cannot join");
    }

    #[test]
    fn updates_modes_duplicates_and_read() {
        let (_dir, _home, _bots, groups) = setup(true);
        let row = group(&groups);
        groups
            .update(GroupUpdateParams {
                id: row.id.clone(),
                name: Some("新名字".into()),
                note: Some("".into()),
                pinned: Some(true),
                resume: None,
            })
            .unwrap();
        let after = groups.open(GroupOpenParams { id: row.id.clone(), before_seq: None, limit: None }).unwrap().group;
        assert_eq!(after.name, "新名字");
        assert_eq!(after.note, None);
        assert!(after.pinned);

        groups
            .set_member(GroupSetMemberParams {
                id: row.id.clone(),
                bot_id: "bot-a".into(),
                mode: Some(GroupMemberMode::Mentions),
                stateless: None,
            })
            .unwrap();
        let member = groups
            .open(GroupOpenParams { id: row.id.clone(), before_seq: None, limit: None })
            .unwrap()
            .group
            .members
            .into_iter()
            .find(|m| m.bot_id == "bot-a")
            .unwrap();
        assert_eq!(member.mode, GroupMemberMode::Mentions);

        let duplicate = groups.add_member(GroupAddMemberParams {
            id: row.id.clone(),
            bot_id: "bot-a".into(),
            mode: None,
            history: None,
        });
        assert_eq!(duplicate.unwrap_err().code, error_code::GROUP_MEMBER_EXISTS);

        groups.read(&row.id).unwrap();
    }

    #[test]
    fn external_members_and_their_history() {
        let (_dir, _home, bots, groups) = setup(true);
        bots.add_external_for_test("ext", "医院助手");
        let row = groups
            .create(GroupCreateParams {
                name: "医院群".into(),
                note: None,
                members: vec![
                    member("bot-a"),
                    GroupMemberInput {
                        bot_id: "ext".into(),
                        mode: None,
                        history: Some(GroupHistory::Summary),
                    },
                ],
            })
            .unwrap();
        assert!(row.external);
        let ext = row.members.iter().find(|m| m.bot_id == "ext").unwrap();
        assert!(ext.external);
        assert_eq!(ext.history, GroupHistory::Summary);
        assert!(groups
            .create(GroupCreateParams {
                name: "缺历史".into(),
                note: None,
                members: vec![GroupMemberInput {
                    bot_id: "ext".into(),
                    mode: None,
                    history: None,
                }],
            })
            .unwrap_err()
            .message
            .contains("history"));

        groups
            .set_member(GroupSetMemberParams {
                id: row.id.clone(),
                bot_id: "ext".into(),
                mode: None,
                stateless: Some(true),
            })
            .unwrap();
        let row = groups.open(GroupOpenParams { id: row.id.clone(), before_seq: None, limit: None }).unwrap().group;
        assert_eq!(row.members.len(), 2);

        groups.remove_member(GroupRemoveMemberParams { id: row.id, bot_id: "ext".into() }).unwrap();
    }

    #[test]
    fn external_can_be_disabled() {
        let (_dir, _home, bots, groups) = setup(false);
        bots.add_external_for_test("ext", "医院助手");
        let err = groups
            .create(GroupCreateParams {
                name: "医院群".into(),
                note: None,
                members: vec![GroupMemberInput {
                    bot_id: "ext".into(),
                    mode: None,
                    history: Some(GroupHistory::None),
                }],
            })
            .unwrap_err();
        assert_eq!(err.code, error_code::GROUP_EXTERNAL_DISABLED);
    }

    #[test]
    fn a_crash_before_the_group_file_does_not_reuse_a_seq() {
        let (_dir, home, bots, groups) = setup(true);
        bots.add_named_for_test("bot-c", "Carol");
        let row = group(&groups);
        let first = send(&groups, &row.id, "第一条");
        assert_eq!(first.seq, 0);
        // The message went to messages.jsonl, then the process died before group.json said so.
        let path = home.group_dir(&row.id).join("group.json");
        let mut saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        saved["next_seq"] = serde_json::json!(0);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();

        let reloaded = Registry::new(home.clone(), bots.clone(), true, GroupsSettings::default());
        let second = send(&reloaded, &row.id, "第二条");
        assert_eq!(second.seq, 1, "the next message must not reuse seq 0");
        reloaded
            .add_member(GroupAddMemberParams {
                id: row.id.clone(),
                bot_id: "bot-c".into(),
                mode: None,
                history: None,
            })
            .unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let joined = saved["members"].as_array().unwrap().iter().find(|m| m["bot_id"] == "bot-c").unwrap()["joined_seq"]
            .as_u64()
            .unwrap();
        assert_eq!(joined, 2);
    }

    #[test]
    fn a_file_must_be_given_by_its_absolute_path() {
        let (_dir, _home, _bots, groups) = setup(true);
        let row = group(&groups);
        let err = groups
            .send(GroupSendParams {
                id: row.id,
                text: "相对路径".into(),
                files: vec!["relative.pdf".into()],
                reply_to: None,
                thread: None,
            })
            .unwrap_err();
        assert!(err.message.contains("absolute path"), "{}", err.message);
    }

    #[test]
    fn open_returns_only_the_threads_on_its_page() {
        let (_dir, _home, _bots, groups) = setup(true);
        let row = group(&groups);
        let root = send(&groups, &row.id, "旧话题");
        groups
            .send(GroupSendParams {
                id: row.id.clone(),
                text: "旧话题的回复".into(),
                files: Vec::new(),
                reply_to: None,
                thread: Some(root.id),
            })
            .unwrap();
        send(&groups, &row.id, "这一页最后一条");
        let open = groups
            .open(GroupOpenParams {
                id: row.id,
                before_seq: None,
                limit: Some(1),
            })
            .unwrap();
        assert_eq!(open.messages.len(), 1);
        assert!(open.threads.is_empty(), "the old thread is not on this page");
    }

    #[test]
    fn deleting_moves_the_folder_to_the_trash() {
        let (_dir, home, _bots, groups) = setup(true);
        let row = group(&groups);
        assert!(home.group_dir(&row.id).exists());
        groups.delete(&row.id).unwrap();
        assert!(!home.group_dir(&row.id).exists());
        assert!(home.trash_groups_dir().join(&row.id).exists());
        assert!(groups.open(GroupOpenParams { id: row.id, before_seq: None, limit: None }).is_err());
    }
}
