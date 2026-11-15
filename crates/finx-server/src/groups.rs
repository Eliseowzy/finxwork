//! Groups (docs/kernel/bot-group-chat-dev-brief.md §4.1): where the owner and several bots talk.
//! The group itself is service-layer state, not a kernel session; a local bot's seat session is
//! made in M2. This file keeps `group.json`, `messages.jsonl` and the group's folder, and answers
//! the `groups/*` methods.

use bytes::Bytes;
use finx_core::FinxHome;
use finx_core::config_edit::replace_file;
use finx_protocol::api::method;
use finx_protocol::bot::Avatar;
use finx_protocol::bot::AvatarHue;
use finx_protocol::group::*;
use finx_rpc::RpcError;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::bots;
use crate::conn::ConnHandle;
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
    /// `None` until read from disk, on first use.
    groups: Mutex<Option<BTreeMap<String, Group>>>,
    feed: ListFeed,
    /// One `group.json` write at a time.
    writing: Mutex<()>,
}

impl Registry {
    pub(crate) fn new(home: FinxHome, bots: Arc<bots::Registry>, external: bool) -> Self {
        Self {
            home,
            bots,
            external,
            groups: Mutex::new(None),
            feed: ListFeed::default(),
            writing: Mutex::new(()),
        }
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
        self.with(|groups| groups.get_mut(id).map(f)).ok_or_else(|| errors::group_not_found(id))?
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

    fn row(&self, id: &str) -> Result<GroupSummary, RpcError> {
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
        self.sync_messages(&p.id)?;
        self.save(&p.id)?;
        self.announce(&[&p.id], Vec::new());
        self.publish(&p.id, &message);
        Ok(GroupSendResult { message })
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
    fn groups(&self) -> &Arc<Registry> {
        &self.0.groups
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

    pub(crate) fn groups_create(&self, p: GroupCreateParams) -> Result<GroupSummary, RpcError> {
        self.groups().create(p)
    }

    pub(crate) fn groups_update(&self, p: GroupUpdateParams) -> Result<(), RpcError> {
        self.groups().update(p)
    }

    pub(crate) fn groups_delete(&self, p: GroupIdParams) -> Result<(), RpcError> {
        self.groups().delete(&p.id)
    }

    pub(crate) fn groups_add_member(&self, p: GroupAddMemberParams) -> Result<GroupSummary, RpcError> {
        self.groups().add_member(p)
    }

    pub(crate) fn groups_remove_member(&self, p: GroupRemoveMemberParams) -> Result<(), RpcError> {
        self.groups().remove_member(p)
    }

    pub(crate) fn groups_set_member(&self, p: GroupSetMemberParams) -> Result<(), RpcError> {
        self.groups().set_member(p)
    }

    pub(crate) fn groups_open(&self, p: GroupOpenParams) -> Result<GroupOpenResult, RpcError> {
        self.groups().open(p)
    }

    pub(crate) fn groups_thread(&self, p: GroupThreadParams) -> Result<GroupThreadResult, RpcError> {
        self.groups().thread(p)
    }

    pub(crate) fn groups_send(&self, p: GroupSendParams) -> Result<GroupSendResult, RpcError> {
        self.groups().send(p)
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
        let groups = Registry::new(home.clone(), bots.clone(), external);
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

        let reloaded = Registry::new(home, bots, true);
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

        let reloaded = Registry::new(home.clone(), bots.clone(), true);
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
