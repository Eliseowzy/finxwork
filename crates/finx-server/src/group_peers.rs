//! External members' delivery (docs/kernel/bot-group-chat-dev-brief.md §4.7): they have no seat
//! session, so the service talks to them over A2A itself. Every member and every stream has a
//! contextId and a read position; a batch carries the messages since that position, and a reply
//! becomes group messages.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::time::Duration;
use std::time::Instant;

use finx_a2a::Client;
use finx_a2a::ClientOptions;
use finx_a2a::Endpoint;
use finx_a2a::GroupMessage as A2aGroupMessage;
use finx_a2a::GroupPart;
use finx_core::PeerEvent;
use finx_core::PeerThread;
use finx_protocol::group::GroupHistory;
use finx_protocol::group::GroupMemberMode;
use finx_protocol::group::GroupMessage;
use finx_protocol::group::GroupSpeaker;
use finx_rpc::RpcError;
use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::json;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::groups::ExternalMember;
use crate::groups::PeerIncomingFile;
use crate::server::Server;

/// The stream key of the main message flow (brief §4.7).
const MAIN: &str = "main";
/// The largest file an external bot may give, as in direct conversations.
const FILE_MAX: usize = 50 * 1024 * 1024;
/// Calls without an answer that pause delivery to one member (brief §4.7).
const FAILURE_LIMIT: u32 = 3;
/// How long a batch's stream may take before it counts as a failure.
const BATCH_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the stateless probe waits for each of its two questions.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// What an external member's delivery needs while the service runs: who is in flight, how many
/// calls failed in a row, and the task a batch is waiting on.
#[derive(Default)]
pub(crate) struct Peers {
    inflight: Mutex<HashSet<(String, String)>>,
    failures: Mutex<BTreeMap<(String, String), u32>>,
    paused: Mutex<HashSet<(String, String)>>,
}

impl Peers {
    fn begin(&self, group: &str, bot: &str) -> bool {
        self.inflight.lock().insert((group.to_string(), bot.to_string()))
    }

    fn end(&self, group: &str, bot: &str) {
        self.inflight.lock().remove(&(group.to_string(), bot.to_string()));
    }

    fn paused(&self, group: &str, bot: &str) -> bool {
        self.paused.lock().contains(&(group.to_string(), bot.to_string()))
    }

    fn failed(&self, group: &str, bot: &str) -> u32 {
        let mut failures = self.failures.lock();
        let key = (group.to_string(), bot.to_string());
        let count = failures.entry(key.clone()).or_insert(0);
        *count += 1;
        let count = *count;
        drop(failures);
        if count >= FAILURE_LIMIT {
            self.paused.lock().insert(key);
        }
        count
    }

    fn succeeded(&self, group: &str, bot: &str) {
        let key = (group.to_string(), bot.to_string());
        self.failures.lock().remove(&key);
        self.paused.lock().remove(&key);
    }

}

impl Server {
    /// Queues one group message for an external member and sends it when it is due (brief §4.7).
    pub(crate) async fn queue_external(&self, group_id: &str, member: &ExternalMember, message: GroupMessage) {
        if self.0.group_peers.paused(group_id, &member.bot_id) {
            return;
        }
        if let GroupSpeaker::Bot { bot_id, .. } = &message.from
            && bot_id == &member.bot_id
        {
            return;
        }
        let mentioned = message.mentions.iter().any(|id| id == &member.bot_id);
        let in_thread = match &message.thread {
            Some(root) => self
                .groups()
                .peer_in_thread(group_id, &member.bot_id, root)
                .unwrap_or(false),
            None => false,
        };
        if member.mode == GroupMemberMode::Mentions && !mentioned && !in_thread {
            return;
        }
        let key = (group_id.to_string(), member.bot_id.clone());
        let settings = self.0.group_settings.clone();
        let lazy = member.mode == GroupMemberMode::Lazy;
        if mentioned || in_thread {
            let mut batch = self.0.group_pending.lock().remove(&key).unwrap_or_default();
            batch.push(message);
            let server = self.handle();
            let group = group_id.to_string();
            let bot = member.bot_id.clone();
            tokio::spawn(async move {
                server.deliver_external(&group, &bot, batch).await;
            });
            return;
        }
        if !matches!(member.mode, GroupMemberMode::Normal | GroupMemberMode::Lazy) {
            return;
        }
        let (first, enough) = {
            let mut pending = self.0.group_pending.lock();
            let entry = pending.entry(key.clone()).or_default();
            let first = entry.is_empty();
            entry.push(message);
            (first, entry.len() >= settings.lazy_count.max(1) as usize)
        };
        if enough {
            let batch = self.0.group_pending.lock().remove(&key).unwrap_or_default();
            let server = self.handle();
            let group = group_id.to_string();
            let bot = member.bot_id.clone();
            tokio::spawn(async move {
                server.deliver_external(&group, &bot, batch).await;
            });
        } else if first {
            let server = self.handle();
            let group = group_id.to_string();
            let bot = member.bot_id.clone();
            tokio::spawn(async move {
                // The quiet period, and the longest wait from the first message. A lazy member
                // waits its own period, or until enough arrived, whichever is first.
                let quiet = Duration::from_secs(if lazy {
                    settings.lazy_secs.max(1)
                } else {
                    settings.quiet_secs.max(1)
                });
                let max = Duration::from_secs(if lazy {
                    settings.lazy_secs.max(1)
                } else {
                    settings.max_wait_secs.max(1)
                });
                let start = Instant::now();
                let mut last = server
                    .0
                    .group_pending
                    .lock()
                    .get(&(group.clone(), bot.clone()))
                    .map(Vec::len)
                    .unwrap_or(0);
                loop {
                    tokio::time::sleep(quiet).await;
                    let now = server
                        .0
                        .group_pending
                        .lock()
                        .get(&(group.clone(), bot.clone()))
                        .map(Vec::len)
                        .unwrap_or(0);
                    if now == last || now == 0 || start.elapsed() >= max {
                        break;
                    }
                    last = now;
                }
                let batch = server.0.group_pending.lock().remove(&(group.clone(), bot.clone())).unwrap_or_default();
                if !batch.is_empty() {
                    server.deliver_external(&group, &bot, batch).await;
                }
            });
        }
    }

    /// Sends the messages this batch is about to one external member. Only one call per member
    /// at a time: a batch that arrives meanwhile waits for the current one (brief §4.7).
    pub(crate) async fn deliver_external(&self, group_id: &str, bot_id: &str, triggers: Vec<GroupMessage>) {
        let key = (group_id.to_string(), bot_id.to_string());
        let mut batch = triggers;
        loop {
            if batch.is_empty() {
                return;
            }
            if !self.0.group_peers.begin(group_id, bot_id) {
                self.0.group_pending.lock().entry(key.clone()).or_default().extend(batch);
                return;
            }
            let result = check_send(self.send_batches(group_id, bot_id, &batch)).await;
            self.0.group_peers.end(group_id, bot_id);
            if let Err(error) = result {
                check_send(self.external_failed(group_id, bot_id, &error)).await;
            }
            // Whatever arrived while it was answering goes next, never alongside.
            batch = self.0.group_pending.lock().remove(&key).unwrap_or_default();
            if self.0.group_peers.paused(group_id, bot_id) {
                return;
            }
        }
    }

    async fn send_batches(&self, group_id: &str, bot_id: &str, triggers: &[GroupMessage]) -> Result<(), RpcError> {
        let members = self.groups().external_members(group_id)?;
        let Some(member) = members.iter().find(|member| member.bot_id == bot_id) else {
            return Ok(());
        };
        let messages = self.groups().messages(group_id)?;
        let mut state = self.groups().peer_state(group_id, bot_id)?;
        let extension = self.group_extension(bot_id);
        let mut streams: Vec<String> = Vec::new();
        for trigger in triggers {
            let stream = trigger.thread.clone().unwrap_or_else(|| MAIN.to_string());
            if !streams.contains(&stream) {
                streams.push(stream);
            }
        }
        for stream in streams {
            let is_thread = stream != MAIN;
            let sent = state.contexts.get(&stream).map(|context| context.sent_seq);
            let first = sent.is_none();
            let mut included: Vec<GroupMessage> = Vec::new();
            if first && is_thread {
                // Pulled into a thread: its first message and the last replies (brief §4.7).
                if let Some(root) = messages.iter().find(|m| m.id == stream && m.thread.is_none()) {
                    included.push(root.clone());
                }
                let replies: Vec<&GroupMessage> = messages
                    .iter()
                    .filter(|m| m.thread.as_deref() == Some(stream.as_str()))
                    .collect();
                let start = replies.len().saturating_sub(self.0.group_settings.recent_count as usize);
                included.extend(replies[start..].iter().map(|m| (*m).clone()));
            } else {
                if first && !is_thread && member.history == GroupHistory::Recent {
                    let older: Vec<&GroupMessage> = messages
                        .iter()
                        .filter(|m| m.thread.is_none() && m.seq < member.joined_seq)
                        .collect();
                    let start = older.len().saturating_sub(self.0.group_settings.recent_count as usize);
                    included.extend(older[start..].iter().map(|m| (*m).clone()));
                }
                for message in &messages {
                    if sent.is_some_and(|sent| message.seq <= sent) {
                        continue;
                    }
                    if message.thread.as_deref().unwrap_or(MAIN) != stream {
                        continue;
                    }
                    if !state.contexts.contains_key(&stream) && message.seq < member.joined_seq {
                        // The history choice above is the only way pre-join messages are sent.
                        continue;
                    }
                    included.push(message.clone());
                }
            }
            included.sort_by_key(|m| m.seq);
            included.dedup_by_key(|m| m.seq);
            let new: Vec<GroupMessage> = included
                .into_iter()
                .filter(|m| !matches!(m.from, GroupSpeaker::System))
                .filter(|m| !matches!(&m.from, GroupSpeaker::Bot { bot_id: from, .. } if from == bot_id))
                .collect();
            if new.is_empty() {
                continue;
            }
            let (summary_upto, summary) = self.groups().rolling_summary(group_id)?;
            let _ = summary_upto;
            let stateless = state.stateless || member.stateless;
            let context_id = if stateless {
                None
            } else {
                state.contexts.get(&stream).map(|context| context.context_id.clone()).filter(|id| !id.is_empty())
            };
            let before = self.0.group_settings.recent_count as usize;
            let recent: Vec<GroupMessage> = if stateless {
                let candidates: Vec<&GroupMessage> = messages
                    .iter()
                    .filter(|m| {
                        m.thread.as_deref().unwrap_or(MAIN) == stream
                            && !matches!(m.from, GroupSpeaker::System)
                            && m.seq >= member.joined_seq
                            && m.seq < new.first().map(|m| m.seq).unwrap_or(u64::MAX)
                    })
                    .collect();
                candidates[candidates.len().saturating_sub(before)..].iter().map(|m| (*m).clone()).collect()
            } else {
                Vec::new()
            };
            let from_seq = new.first().map(|m| m.seq).unwrap_or(0);
            let to_seq = new.last().map(|m| m.seq).unwrap_or(0);
            let mentioned = new.iter().any(|m| m.mentions.iter().any(|id| id == bot_id));
            let group = self.groups().row(group_id)?;
            let show_members = extension && !state.members_sent;
            let members = if show_members {
                Some(self.members_json(group_id)?)
            } else {
                None
            };
            let first_batch = first || show_members;
            let header = history_header(
                first && !is_thread,
                member.history,
                &summary,
                stateless,
                &recent,
            );
            let parts = if extension {
                let mut parts: Vec<GroupPart> = new
                    .iter()
                    .map(|message| GroupPart {
                        text: text_of(message),
                        metadata: Some(json!({ "speaker": speaker_json(message) })),
                    })
                    .collect();
                if !header.is_empty()
                    && let Some(first_part) = parts.first_mut()
                {
                    first_part.text = format!("{header}{}", first_part.text);
                }
                parts
            } else {
                let mut text = String::new();
                if first_batch {
                    text.push_str(&fallback_intro(&group.name, &self.members_lines(group_id)?));
                    text.push('\n');
                }
                text.push_str(&header);
                for message in &new {
                    text.push_str(&format!("【{}】{}\n", speaker_name(&message.from), text_of(message)));
                }
                vec![GroupPart {
                    text: text.trim_end().to_string(),
                    metadata: None,
                }]
            };
            let metadata = extension.then(|| {
                let mut metadata = json!({
                    "group": { "id": group_id, "name": group.name, "thread": if is_thread { Some(stream.clone()) } else { None } },
                    "seq": { "from": from_seq, "to": to_seq },
                    "mentioned": mentioned,
                });
                if let Some(members) = members {
                    metadata["members"] = members;
                }
                metadata
            });
            let client = self.external_client(bot_id)?;
            let a2a = A2aGroupMessage {
                id: uuid::Uuid::now_v7().to_string(),
                parts,
                metadata,
                extension,
            };
            let thread = PeerThread {
                context_id,
                task_id: self.groups().peer_task(group_id, bot_id).map(|(task, _)| task),
                waiting: false,
            };
            let result = self.run_batch(&client, a2a, thread, group_id, bot_id, &stream).await;
            let (received, failure, context) = match result {
                Ok(value) => value,
                Err(error) => return Err(RpcError::internal(format!("{}: {error}", member.name))),
            };
            if let Some(error) = failure {
                return Err(RpcError::internal(error));
            }
            if let Some(context_id) = context.filter(|id| !id.is_empty())
                && !stateless
            {
                let _ = self.groups().set_peer_context(group_id, bot_id, &stream, &context_id);
            }
            if let Some(task) = received.task_id.clone() {
                let _ = self.groups().set_peer_task(group_id, bot_id, Some(task), Some(stream.clone()));
            }
            let silent = received.silent();
            if silent {
                let _ = self.groups().silence(group_id, bot_id, from_seq, to_seq, false, Some("no content"));
            } else {
                if let Some(asked) = received.asked.clone() {
                    if let Ok(message) =
                        self.groups()
                            .append_external(group_id, bot_id, asked, Vec::new(), is_thread.then(|| stream.clone()), None)
                    {
                        self.pass_on_reply(group_id, bot_id, message);
                    }
                } else {
                    let _ = self.groups().set_peer_task(group_id, bot_id, None, None);
                }
                let said: Vec<String> = received
                    .said
                    .into_iter()
                    .filter(|text| !text.trim().is_empty() && !is_pass(text))
                    .collect();
                let mut files = received.files;
                for (index, text) in said.iter().enumerate() {
                    let files = if index == 0 { std::mem::take(&mut files) } else { Vec::new() };
                    if let Ok(message) = self.groups().append_external(
                        group_id,
                        bot_id,
                        text.clone(),
                        files,
                        is_thread.then(|| stream.clone()),
                        None,
                    ) {
                        self.pass_on_reply(group_id, bot_id, message);
                    }
                }
                if !files.is_empty()
                    && let Ok(message) = self.groups().append_external(
                        group_id,
                        bot_id,
                        String::new(),
                        files,
                        is_thread.then(|| stream.clone()),
                        None,
                    )
                {
                    self.pass_on_reply(group_id, bot_id, message);
                }
            }
            self.0.group_peers.succeeded(group_id, bot_id);
            let _ = self.groups().advance_peer_sent(group_id, bot_id, &stream, to_seq);
            if extension && !state.members_sent {
                let _ = self.groups().mark_peer_members_sent(group_id, bot_id);
                state.members_sent = true;
            }
            let server = self.handle();
            let group = group_id.to_string();
            tokio::spawn(async move {
                let _ = server.maybe_summarize(&group).await;
            });
        }
        Ok(())
    }

    async fn run_batch(
        &self,
        client: &Client,
        message: A2aGroupMessage,
        thread: PeerThread,
        group_id: &str,
        bot_id: &str,
        stream: &str,
    ) -> Result<(Received, Option<String>, Option<String>), String> {
        let mut events = client
            .send_group(message, thread, CancellationToken::new())
            .await
            .map_err(|error| error.to_string())?;
        let mut received = Received::default();
        let mut failure = None;
        let mut context = None;
        let read = async {
            while let Some(event) = events.next().await {
                match event {
                    PeerEvent::Thread(thread) => {
                        context = thread.context_id.clone();
                        if let Some(task) = thread.task_id.clone() {
                            received.task_id = Some(task.clone());
                            // Save it as soon as the other side gives it: a dropped stream must
                            // still be resumable after a restart (contacts §5.5).
                            let _ = self.groups().set_peer_task(group_id, bot_id, Some(task), Some(stream.to_string()));
                        }
                    }
                    PeerEvent::Said { text } => received.said.push(text),
                    PeerEvent::File { name, media_type, bytes } => {
                        if bytes.len() <= FILE_MAX {
                            received.files.push(PeerIncomingFile {
                                name,
                                media_type,
                                bytes,
                            });
                        }
                    }
                    PeerEvent::Asked { text } => received.asked = Some(text),
                    PeerEvent::Failed(error) => {
                        failure = Some(error.message.clone());
                        break;
                    }
                    PeerEvent::Working => {}
                    PeerEvent::Done => break,
                }
            }
        };
        tokio::time::timeout(BATCH_TIMEOUT, read)
            .await
            .map_err(|_| "the other side did not finish in time".to_string())?;
        Ok((received, failure, context))
    }

    fn pass_on_reply(&self, group_id: &str, bot_id: &str, message: GroupMessage) {
        let server = self.handle();
        let group = group_id.to_string();
        let bot = bot_id.to_string();
        tokio::spawn(async move {
            server.pass_on(&group, Some(&bot), message).await;
        });
    }

    async fn external_failed(&self, group_id: &str, bot_id: &str, error: &RpcError) {
        let name = self
            .groups()
            .external_members(group_id)
            .ok()
            .and_then(|members| members.into_iter().find(|m| m.bot_id == bot_id).map(|m| m.name))
            .unwrap_or_else(|| bot_id.to_string());
        let failures = self.0.group_peers.failed(group_id, bot_id);
        let _ = self.groups().system(group_id, format!("{name} 出错了：{}", error.message));
        if failures >= FAILURE_LIMIT {
            let _ = self
                .groups()
                .system(group_id, format!("{name} 连续 {FAILURE_LIMIT} 次出错，暂时不给它发消息了。请到 Bot 设置里看一下。"));
        }
    }

    fn external_client(&self, bot_id: &str) -> Result<Client, RpcError> {
        let Some(source) = self.a2a_source(bot_id)? else {
            return Err(RpcError::internal("that bot is not external"));
        };
        Client::new(
            Endpoint {
                url: source.endpoint,
                tenant: source.tenant,
            },
            source.auth,
            ClientOptions {
                allow_local: source.allow_local,
            },
        )
        .map_err(|error| RpcError::internal(error.to_string()))
    }

    fn members_json(&self, group_id: &str) -> Result<Value, RpcError> {
        let mut out = vec![json!({ "name": "Owner", "kind": "owner", "external": false })];
        for (_, name, _mode) in self.groups().local_members(group_id)? {
            out.push(json!({ "name": name, "kind": "bot", "external": false }));
        }
        for member in self.groups().external_members(group_id)? {
            out.push(json!({ "name": member.name, "kind": "bot", "external": true }));
        }
        Ok(Value::Array(out))
    }

    fn members_lines(&self, group_id: &str) -> Result<String, RpcError> {
        let mut names = vec!["Owner".to_string()];
        names.extend(self.groups().local_members(group_id)?.into_iter().map(|(_, name, _)| name));
        names.extend(
            self.groups()
                .external_members(group_id)?
                .into_iter()
                .map(|member| format!("{} (external)", member.name)),
        );
        Ok(names.join(", "))
    }

    /// Runs the stateless probe for a newly added external member (brief §4.7).
    pub(crate) async fn probe_stateless(&self, group_id: &str, bot_id: &str) {
        let stateless = self.probe_once(bot_id).await;
        let _ = self.groups().set_peer_stateless(group_id, bot_id, stateless);
    }

    async fn probe_once(&self, bot_id: &str) -> bool {
        let Ok(client) = self.external_client(bot_id) else {
            return true;
        };
        let first = client.send_group(
            A2aGroupMessage {
                id: uuid::Uuid::now_v7().to_string(),
                parts: vec![GroupPart {
                    text: "Remember the word KIWI. Reply only OK.".to_string(),
                    metadata: None,
                }],
                metadata: None,
                extension: false,
            },
            PeerThread::default(),
            CancellationToken::new(),
        );
        let Ok(events) = first.await else {
            return true;
        };
        let Some((context, _)) = self.probe_reply(events, false).await else {
            return true;
        };
        let Some(context) = context else {
            return true;
        };
        let second = client.send_group(
            A2aGroupMessage {
                id: uuid::Uuid::now_v7().to_string(),
                parts: vec![GroupPart {
                    text: "What word did I ask you to remember? Reply with the word only.".to_string(),
                    metadata: None,
                }],
                metadata: None,
                extension: false,
            },
            PeerThread {
                context_id: Some(context),
                task_id: None,
                waiting: false,
            },
            CancellationToken::new(),
        );
        let Ok(events) = second.await else {
            return true;
        };
        match self.probe_reply(events, true).await {
            Some((_, true)) => false,
            _ => true,
        }
    }

    async fn probe_reply(
        &self,
        mut events: futures::stream::BoxStream<'static, PeerEvent>,
        want_word: bool,
    ) -> Option<(Option<String>, bool)> {
        let mut context = None;
        let mut said = String::new();
        let read = async {
            while let Some(event) = events.next().await {
                match event {
                    PeerEvent::Thread(thread) => context = thread.context_id.clone(),
                    PeerEvent::Said { text } => said.push_str(&text),
                    PeerEvent::Failed(_) | PeerEvent::Done => break,
                    _ => {}
                }
            }
        };
        tokio::time::timeout(PROBE_TIMEOUT, read).await.ok()?;
        let ok = !want_word || said.contains("KIWI");
        Some((context, ok))
    }

    /// Adds the messages `upto_seq` did not cover to the rolling summary, when enough piled up
    /// (brief §4.7). Asynchronous: delivery never waits for it.
    pub(crate) async fn maybe_summarize(&self, group_id: &str) -> Result<(), RpcError> {
        // Only external members read the summary; a group without any never spends a model call.
        if self.groups().external_members(group_id)?.is_empty() {
            return Ok(());
        }
        let (upto, old) = self.groups().rolling_summary(group_id)?;
        let messages = self.groups().messages(group_id)?;
        let unsummarized: Vec<&GroupMessage> = messages.iter().filter(|m| m.seq > upto).collect();
        if unsummarized.len() <= self.0.group_settings.summary_after as usize {
            return Ok(());
        }
        let keep = self.0.group_settings.recent_count as usize;
        let Some(boundary) = unsummarized.len().checked_sub(keep + 1).and_then(|index| unsummarized.get(index)) else {
            return Ok(());
        };
        let boundary_seq = boundary.seq;
        let chunk: Vec<&GroupMessage> = unsummarized.iter().copied().filter(|m| m.seq <= boundary_seq).collect();
        if chunk.is_empty() {
            return Ok(());
        }
        let model = match self.session_model(None, None).await {
            Ok(model) => model,
            // No default model: sending only the last few messages is the fallback.
            Err(_) => return Ok(()),
        };
        let Ok(resolved) = self.0.llm.resolve(&model) else {
            return Ok(());
        };
        let transcript = transcript_of(&chunk);
        let prompt = include_str!("prompts/group_summary.md");
        let input = format!(
            "Current summary:\n{}\n\nNew messages:\n{transcript}",
            if old.is_empty() { "(none)" } else { &old }
        );
        let context = finx_llm::Context {
            system: prompt.to_string(),
            messages: vec![finx_llm::Message::from(finx_llm::UserMessage::text(input))],
            tools: Vec::new(),
        };
        let options = finx_llm::RequestOptions {
            max_output_tokens: Some(1200),
            ..Default::default()
        };
        let mut stream = self.0.llm.stream(resolved.model, context, options);
        let mut text = String::new();
        while let Some(event) = stream.next().await {
            match event {
                finx_llm::StreamEvent::Done(message) => {
                    text = message.text();
                    break;
                }
                finx_llm::StreamEvent::Failed(_) => return Ok(()),
                finx_llm::StreamEvent::TextDelta { text: delta, .. } => text.push_str(&delta),
                _ => {}
            }
        }
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        self.groups().set_summary(group_id, boundary_seq, text.chars().take(8000).collect())
    }
}

fn check_send<F: std::future::Future + Send>(f: F) -> F { f }

fn speaker_name(from: &GroupSpeaker) -> &str {
    match from {
        GroupSpeaker::Owner => "Owner",
        GroupSpeaker::System => "System",
        GroupSpeaker::Bot { name, .. } => name,
    }
}

fn text_of(message: &GroupMessage) -> String {
    let mut text = message.text.clone();
    for file in &message.files {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!(
            "{} sent {} ({})",
            speaker_name(&message.from),
            file.name,
            size_words(file.size)
        ));
    }
    text
}

fn size_words(size: u64) -> String {
    if size >= 1024 * 1024 {
        format!("{} MB", (size as f64 / (1024.0 * 1024.0)).round() as u64)
    } else if size >= 1024 {
        format!("{} KB", (size as f64 / 1024.0).round() as u64)
    } else {
        format!("{size} B")
    }
}

fn speaker_json(message: &GroupMessage) -> Value {
    match &message.from {
        GroupSpeaker::Owner => json!({
            "name": "Owner",
            "kind": "owner",
            "external": false,
            "message_id": message.id,
            "reply_to": message.reply_to,
        }),
        GroupSpeaker::System => json!({
            "name": "System",
            "kind": "owner",
            "external": false,
            "message_id": message.id,
            "reply_to": message.reply_to,
        }),
        GroupSpeaker::Bot { name, external, .. } => json!({
            "name": name,
            "kind": "bot",
            "external": external,
            "message_id": message.id,
            "reply_to": message.reply_to,
        }),
    }
}

/// The words a first batch carries before the new messages: the summary the member may see, and
/// for a stateless member every batch repeats the summary and the last few messages (brief §4.7).
fn history_header(
    history_applies: bool,
    history: GroupHistory,
    summary: &str,
    stateless: bool,
    recent: &[GroupMessage],
) -> String {
    let mut header = String::new();
    let show_summary = if stateless { true } else { history_applies && history != GroupHistory::None };
    if show_summary && !summary.is_empty() {
        header.push_str(&format!("[Earlier in this group]\n{summary}\n\n"));
    }
    if stateless && !recent.is_empty() {
        for message in recent {
            header.push_str(&format!(
                "[#{} {}] {}\n",
                message.seq,
                speaker_name(&message.from),
                text_of(message)
            ));
        }
        header.push('\n');
    }
    header
}

fn fallback_intro(group: &str, members: &str) -> String {
    format!(
        "You are in the finx group \"{group}\". Members: {members}. Messages are written as 【speaker】content. If you have nothing to say, reply with only PASS."
    )
}

fn transcript_of(messages: &[&GroupMessage]) -> String {
    let mut out = String::new();
    for message in messages {
        let thread = message.thread.as_deref().map(|root| format!(" in thread {root}")).unwrap_or_default();
        out.push_str(&format!(
            "[#{}] {} ({}){thread}: {}\n",
            message.seq,
            speaker_name(&message.from),
            match &message.from {
                GroupSpeaker::Owner => "owner",
                GroupSpeaker::System => "system",
                GroupSpeaker::Bot { external: true, .. } => "external bot",
                GroupSpeaker::Bot { .. } => "bot",
            },
            text_of(message)
        ));
    }
    out
}

#[derive(Default)]
struct Received {
    said: Vec<String>,
    files: Vec<PeerIncomingFile>,
    asked: Option<String>,
    task_id: Option<String>,
}

impl Received {
    /// No words, no files, no question: the member chose not to speak (brief §4.7).
    fn silent(&self) -> bool {
        if self.asked.is_some() || !self.files.is_empty() {
            return false;
        }
        self.said.iter().all(|text| text.trim().is_empty() || is_pass(text))
    }
}

fn is_pass(text: &str) -> bool {
    text.trim().eq_ignore_ascii_case("PASS")
}


impl Server {
    /// After a restart, picks up every external member's task that was still running
    /// (bot-contacts-design §5.5).
    pub(crate) async fn resume_external_tasks(&self) {
        for (group, bot, task, stream) in self.groups().external_tasks() {
            let server = self.handle();
            tokio::spawn(async move {
                let _ = server.resume_external_task(&group, &bot, &task, stream.as_deref()).await;
            });
        }
    }

    async fn resume_external_task(&self, group_id: &str, bot_id: &str, task_id: &str, stream: Option<&str>) -> Result<(), RpcError> {
        let client = self.external_client(bot_id)?;
        let thread = PeerThread {
            context_id: None,
            task_id: Some(task_id.to_string()),
            waiting: false,
        };
        let mut events = client
            .resume(thread, CancellationToken::new())
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?;
        let mut received = Received::default();
        let mut failure = None;
        while let Some(event) = events.next().await {
            match event {
                PeerEvent::Thread(thread) => {
                    if let Some(task) = thread.task_id {
                        received.task_id = Some(task);
                    }
                }
                PeerEvent::Said { text } => received.said.push(text),
                PeerEvent::File { name, media_type, bytes } => {
                    if bytes.len() <= FILE_MAX {
                        received.files.push(PeerIncomingFile { name, media_type, bytes });
                    }
                }
                PeerEvent::Asked { text } => received.asked = Some(text),
                PeerEvent::Done => break,
                PeerEvent::Failed(error) => {
                    failure = Some(error);
                    break;
                }
                PeerEvent::Working => {}
            }
        }
        if let Some(error) = failure {
            let _ = self.groups().system(group_id, format!("{bot_id} 出错了：{}", error.message));
            let _ = self.groups().set_peer_task(group_id, bot_id, None, None);
            return Ok(());
        }
        let thread_of = stream.filter(|stream| *stream != MAIN).map(str::to_string);
        let silent = received.silent();
        if silent {
            let _ = self.groups().silence(group_id, bot_id, 0, 0, false, Some("no content after restart"));
        } else {
            if let Some(asked) = received.asked {
                if let Ok(message) = self.groups().append_external(group_id, bot_id, asked, Vec::new(), thread_of.clone(), None) {
                    self.pass_on_reply(group_id, bot_id, message);
                }
            }
            let mut files = std::mem::take(&mut received.files);
            for (index, text) in received.said.into_iter().enumerate() {
                if text.trim().is_empty() || is_pass(&text) {
                    continue;
                }
                let files = if index == 0 { std::mem::take(&mut files) } else { Vec::new() };
                if let Ok(message) = self.groups().append_external(group_id, bot_id, text, files, thread_of.clone(), None) {
                    self.pass_on_reply(group_id, bot_id, message);
                }
            }
            if !files.is_empty()
                && let Ok(message) = self.groups().append_external(group_id, bot_id, String::new(), files, thread_of, None)
            {
                self.pass_on_reply(group_id, bot_id, message);
            }
        }
        let task = received.task_id;
        let stream = stream.map(str::to_string);
        let _ = self.groups().set_peer_task(group_id, bot_id, task, stream);
        Ok(())
    }
}
