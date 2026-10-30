//! The native protocol: `session/op` carries an Op and `session/event` an Event, both in the
//! same JSON as the in-process API, so no field is mapped on the way through.

use bytes::Bytes;
use finx_protocol::Op;
use finx_protocol::PROTOCOL_VERSION;
use finx_protocol::api::AuthDeleteParams;
use finx_protocol::api::AuthSetParams;
use finx_protocol::api::InitializeParams;
use finx_protocol::api::InitializeResult;
use finx_protocol::api::ModelsListResult;
use finx_protocol::api::ModelsRefreshParams;
use finx_protocol::api::ModelsShowParams;
use finx_protocol::api::PeerInfo;
use finx_protocol::api::ResourceReadParams;
use finx_protocol::api::ServerCapabilities;
use finx_protocol::api::SessionAttachParams;
use finx_protocol::api::SessionHistoryParams;
use finx_protocol::api::SessionIdParams;
use finx_protocol::api::SessionListParams;
use finx_protocol::api::SessionNewParams;
use finx_protocol::api::SessionOpParams;
use finx_protocol::api::SessionRenameParams;
use finx_protocol::api::SessionResumeParams;
use finx_protocol::api::SessionSnapshot;
use finx_protocol::api::SkillsListParams;
use finx_protocol::api::method;
use finx_rpc::Id;
use finx_rpc::Kind;
use finx_rpc::RawMessage;
use finx_rpc::RpcError;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio::task::AbortHandle;

use crate::conn::ConnHandle;
use crate::conn::Encoder;
use crate::conn::Outgoing;
use crate::conn::Protocol;
use crate::errors;
use crate::hub::AttachRequest;
use crate::server::NewSession;
use crate::server::ResumeOverrides;
use crate::server::Server;

pub struct NativeProtocol {
    server: Server,
    initialized: AtomicBool,
    /// Spawned requests that `$/cancel_request` can abort.
    running: Arc<Mutex<HashMap<Id, AbortHandle>>>,
}

#[derive(Serialize)]
struct NewResult<'a> {
    session_id: &'a str,
    snapshot: &'a SessionSnapshot,
}

#[derive(Serialize)]
struct SnapshotResult<'a> {
    snapshot: &'a SessionSnapshot,
}

#[derive(Deserialize)]
struct CancelParams {
    id: Id,
}

fn reply<T: Serialize>(id: &Id, result: Result<T, RpcError>) -> Vec<u8> {
    match result {
        Ok(value) => finx_rpc::response(id, &value),
        Err(error) => finx_rpc::error_response(Some(id), &error),
    }
}

impl NativeProtocol {
    pub fn new(server: Server) -> Arc<Self> {
        Arc::new(Self {
            server,
            initialized: AtomicBool::new(false),
            running: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Runs a request in its own task; the task answers on its own unless cancelled.
    fn spawn<F>(&self, id: Id, conn: &ConnHandle, work: F)
    where
        F: Future<Output = Option<Vec<u8>>> + Send + 'static,
    {
        let running = self.running.clone();
        let conn = conn.clone();
        let key = id.clone();
        let mut guard = self.running.lock();
        let task = tokio::spawn(async move {
            let out = work.await;
            if running.lock().remove(&key).is_some()
                && let Some(out) = out
            {
                conn.send(out);
            }
        });
        guard.insert(id, task.abort_handle());
    }

    fn cancel(&self, id: &Id, conn: &ConnHandle) {
        if let Some(task) = self.running.lock().remove(id) {
            task.abort();
            conn.send_error(Some(id), &RpcError::cancelled());
        }
    }

    fn attach_request(
        conn: &ConnHandle,
        id: &Id,
        events: finx_protocol::api::EventFilter,
        limit: Option<u32>,
        new: bool,
    ) -> AttachRequest {
        let reply_id = id.clone();
        let respond: crate::hub::Responder = if new {
            Box::new(move |snapshot: &SessionSnapshot| {
                let result = NewResult {
                    session_id: &snapshot.session.session_id,
                    snapshot,
                };
                vec![Outgoing::Frame(Bytes::from(finx_rpc::response(
                    &reply_id, &result,
                )))]
            })
        } else {
            Box::new(move |snapshot: &SessionSnapshot| {
                vec![Outgoing::Frame(Bytes::from(finx_rpc::response(
                    &reply_id,
                    &SnapshotResult { snapshot },
                )))]
            })
        };
        AttachRequest {
            conn: conn.clone(),
            filter: events,
            history_limit: Some(limit.map_or(100, |n| n.clamp(1, 1000)) as usize),
            respond,
        }
    }

    fn request(
        self: &Arc<Self>,
        id: &Id,
        method_name: &str,
        params: Option<&RawValue>,
        conn: &ConnHandle,
    ) {
        if method_name != method::INITIALIZE && !self.initialized.load(Ordering::Relaxed) {
            conn.send_error(Some(id), &errors::not_initialized());
            return;
        }
        let server = self.server.clone();
        match method_name {
            method::INITIALIZE => {
                let result = finx_rpc::params::<InitializeParams>(params).and_then(|p| {
                    // Version 2 renamed the permission modes, so older clients are refused.
                    if p.protocol_version < PROTOCOL_VERSION {
                        return Err(RpcError {
                            data: Some(json!({"kind": "invalid_params", "supported": [PROTOCOL_VERSION]})),
                            ..RpcError::invalid_params(format!(
                                "unsupported protocol version {}; this server speaks {PROTOCOL_VERSION}",
                                p.protocol_version
                            ))
                        });
                    }
                    conn.coalesce.store(p.capabilities.coalesce, Ordering::Relaxed);
                    self.initialized.store(true, Ordering::Relaxed);
                    Ok(InitializeResult {
                        protocol_version: PROTOCOL_VERSION,
                        server_info: PeerInfo {
                            name: "finx".into(),
                            version: Some(env!("CARGO_PKG_VERSION").into()),
                        },
                        capabilities: ServerCapabilities {
                            max_frame_bytes: server.settings().max_frame_bytes as u64,
                            session_delete: true,
                            resource_read: true,
                            event_filter: true,
                            sessions_subscribe: true,
                            session_metadata: true,
                            transcript_task_end: true,
                            auth: true,
                            agents: true,
                            model_connections: true,
                            model_discovery: true,
                        },
                    })
                });
                conn.send(reply(id, result));
            }
            method::SESSION_NEW => match finx_rpc::params::<SessionNewParams>(params) {
                Ok(p) => {
                    let attach = Self::attach_request(conn, id, p.events, p.history_limit, true);
                    let args = NewSession {
                        cwd: p.cwd,
                        extra_roots: p.extra_roots,
                        model: p.model,
                        thinking: p.thinking,
                        permission_mode: p.permission_mode,
                        mcp_servers: p.mcp_servers,
                    };
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        match server.create_session(args, attach).await {
                            Ok(_) => None,
                            Err(err) => Some(finx_rpc::error_response(Some(&reply_id), &err)),
                        }
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_RESUME => match finx_rpc::params::<SessionResumeParams>(params) {
                Ok(p) => {
                    let attach = Self::attach_request(conn, id, p.events, p.history_limit, false);
                    let overrides = ResumeOverrides {
                        model: p.model,
                        thinking: p.thinking,
                        permission_mode: p.permission_mode,
                        mcp_servers: p.mcp_servers,
                    };
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        match server
                            .resume_session(&p.session_id, overrides, attach)
                            .await
                        {
                            Ok(()) => None,
                            Err(err) => Some(finx_rpc::error_response(Some(&reply_id), &err)),
                        }
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_ATTACH => match finx_rpc::params::<SessionAttachParams>(params) {
                Ok(p) => {
                    let attach = Self::attach_request(conn, id, p.events, p.history_limit, false);
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        if let Err(err) = server.attach(&p.session_id, attach).await {
                            conn.send_error(Some(&id), &err);
                        }
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_DETACH => match finx_rpc::params::<SessionIdParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        let reply_id = id.clone();
                        let respond: crate::hub::DetachResponder = Box::new(move || {
                            vec![Outgoing::Frame(Bytes::from(finx_rpc::response(
                                &reply_id,
                                &json!({}),
                            )))]
                        });
                        if let Err(err) = server
                            .detach(&p.session_id, conn.clone(), Some(respond))
                            .await
                        {
                            conn.send_error(Some(&id), &err);
                        }
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_OP => match finx_rpc::params::<SessionOpParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        let reply_id = id.clone();
                        let respond: crate::hub::OpResponder = Box::new(move |result| {
                            vec![Outgoing::Frame(Bytes::from(reply(
                                &reply_id,
                                result.map(|()| json!({})),
                            )))]
                        });
                        if let Err(err) = server
                            .submit(&p.session_id, conn.clone(), p.op, false, respond)
                            .await
                        {
                            conn.send_error(Some(&id), &err);
                        }
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_HISTORY => match finx_rpc::params::<SessionHistoryParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        let limit = p.limit.unwrap_or(100).clamp(1, 1000) as usize;
                        let result = server.history(&p.session_id, p.before, limit).await;
                        conn.send(reply(&id, result));
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_LIST => match finx_rpc::params::<Option<SessionListParams>>(params) {
                Ok(p) => {
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        let result = tokio::task::spawn_blocking(move || {
                            server.list_sessions(&p.unwrap_or_default())
                        })
                        .await
                        .unwrap_or_else(|e| Err(RpcError::internal(e.to_string())));
                        Some(reply(&reply_id, result))
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_CLOSE => match finx_rpc::params::<SessionIdParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        let result = server
                            .close_session(&p.session_id)
                            .await
                            .map(|()| json!({}));
                        conn.send(reply(&id, result));
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::SESSION_DELETE => match finx_rpc::params::<SessionIdParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        if server.is_loaded(&p.session_id) {
                            let _ = server.close_session(&p.session_id).await;
                        }
                        let result = tokio::task::spawn_blocking(move || {
                            server.delete_session(&p.session_id)
                        })
                        .await
                        .unwrap_or_else(|e| Err(RpcError::internal(e.to_string())))
                        .map(|()| json!({}));
                        conn.send(reply(&id, result));
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::RESOURCE_READ => match finx_rpc::params::<ResourceReadParams>(params) {
                Ok(p) => {
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        let result = tokio::task::spawn_blocking(move || server.read_resource(&p))
                            .await
                            .unwrap_or_else(|e| Err(RpcError::internal(e.to_string())));
                        Some(reply(&reply_id, result))
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::CONNECTIONS_LIST => conn.send(reply(id, server.0.connections.snapshot().map_err(crate::connections::rpc_error))),
            method::CONNECTIONS_DISCOVER => {
                let reply_id = id.clone();
                self.spawn(id.clone(), conn, async move {
                    Some(reply(&reply_id, server.0.connections.discover().await.map(|discoveries| finx_protocol::api::ConnectionsDiscoveryResult{discoveries}).map_err(crate::connections::rpc_error)))
                });
            }
            method::CONNECTIONS_CONNECT => match finx_rpc::params::<finx_protocol::api::ConnectionConnectParams>(params) {
                Ok(p) => {
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        Some(reply(&reply_id, server.0.connections.connect(p).await.map_err(crate::connections::rpc_error)))
                    });
                }
                Err(error) => conn.send_error(Some(id), &error),
            },
            method::CONNECTIONS_RETRY | method::CONNECTIONS_DISCONNECT | method::CONNECTIONS_REMOVE | method::CONNECTIONS_MODELS => match finx_rpc::params::<finx_protocol::api::ConnectionIdParams>(params) {
                Ok(p) => {
                    let reply_id = id.clone(); let method = method_name.to_string();
                    self.spawn(id.clone(), conn, async move {
                        let manager = &server.0.connections;
                        let result = match method.as_str() {
                            method::CONNECTIONS_DISCONNECT => manager.disconnect(&p.connection_id).await,
                            method::CONNECTIONS_REMOVE => manager.remove(&p.connection_id).await,
                            _ => manager.retry(&p.connection_id).await,
                        };
                        Some(reply(&reply_id, result.map_err(crate::connections::rpc_error)))
                    });
                }
                Err(error) => conn.send_error(Some(id), &error),
            },
            method::SKILLS_LIST => match finx_rpc::params::<SkillsListParams>(params) {
                Ok(p) => {
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move { Some(reply(&reply_id, server.list_skills(p).await)) });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::MODELS_LIST => {
                server.watch_models(conn);
                // Saved keys may be read from the keychain on the first listing.
                let (conn, id) = (conn.clone(), id.clone());
                tokio::spawn(async move {
                    server.refresh_local_models().await;
                    let result: Result<ModelsListResult, RpcError> =
                        tokio::task::spawn_blocking(move || server.list_models())
                            .await
                            .map_err(|e| RpcError::internal(e.to_string()));
                    conn.send(reply(&id, result));
                });
            }
            method::SERVER_SHUTDOWN => {
                conn.send(finx_rpc::response(id, &json!({})));
                server.request_shutdown();
            }
            method::SESSIONS_SUBSCRIBE => {
                match finx_rpc::params::<Option<SessionListParams>>(params) {
                    Ok(p) => {
                        let (conn, id) = (conn.clone(), id.clone());
                        tokio::task::spawn_blocking(move || {
                            server.subscribe_sessions(&conn, &p.unwrap_or_default(), |result| {
                                reply(&id, result)
                            });
                        });
                    }
                    Err(err) => conn.send_error(Some(id), &err),
                }
            }
            method::SESSIONS_UNSUBSCRIBE => {
                server.unsubscribe_sessions(conn);
                conn.send(finx_rpc::response(id, &json!({})));
            }
            method::SESSION_RENAME | method::SESSION_ARCHIVE | method::SESSION_UNARCHIVE => {
                let parsed = match method_name {
                    method::SESSION_RENAME => finx_rpc::params::<SessionRenameParams>(params)
                        .map(|p| (p.session_id, Op::SetTitle { title: p.title })),
                    archive => finx_rpc::params::<SessionIdParams>(params).map(|p| {
                        let archived = archive == method::SESSION_ARCHIVE;
                        (p.session_id, Op::SetArchived { archived })
                    }),
                };
                match parsed {
                    Ok((session_id, op)) => {
                        let (conn, id) = (conn.clone(), id.clone());
                        tokio::spawn(async move {
                            let result = server
                                .set_metadata(&session_id, op)
                                .await
                                .map(|()| json!({}));
                            conn.send(reply(&id, result));
                        });
                    }
                    Err(err) => conn.send_error(Some(id), &err),
                }
            }
            method::AUTH_SET => match finx_rpc::params::<AuthSetParams>(params) {
                Ok(p) => {
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        Some(reply(&reply_id, server.set_key(&p.provider, &p.api_key).await))
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::AUTH_DELETE => match finx_rpc::params::<AuthDeleteParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        let result = tokio::task::spawn_blocking(move || server.delete_key(&p.provider))
                            .await
                            .unwrap_or_else(|e| Err(RpcError::internal(e.to_string())))
                            .map(|()| json!({}));
                        conn.send(reply(&id, result));
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::MODELS_REFRESH => match finx_rpc::params::<Option<ModelsRefreshParams>>(params) {
                Ok(p) => {
                    let reply_id = id.clone();
                    self.spawn(id.clone(), conn, async move {
                        Some(reply(&reply_id, server.refresh_models(p.unwrap_or_default()).await))
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            method::MODELS_SHOW => match finx_rpc::params::<ModelsShowParams>(params) {
                Ok(p) => {
                    let (conn, id) = (conn.clone(), id.clone());
                    tokio::spawn(async move {
                        let result = tokio::task::spawn_blocking(move || server.show_model(&p.model, p.shown))
                            .await
                            .unwrap_or_else(|e| Err(RpcError::internal(e.to_string())))
                            .map(|()| json!({}));
                        conn.send(reply(&id, result));
                    });
                }
                Err(err) => conn.send_error(Some(id), &err),
            },
            other => conn.send_error(Some(id), &RpcError::method_not_found(other)),
        }
    }
}

impl Protocol for NativeProtocol {
    fn on_line(self: Arc<Self>, line: Bytes, conn: &ConnHandle) {
        let message = match RawMessage::parse(&line) {
            Ok(message) => message,
            Err(err) => {
                conn.send_error(None, &err);
                return;
            }
        };
        match message.kind() {
            Kind::Request { id, method, params } => self.request(id, method, params, conn),
            Kind::Notification { method, params } => {
                if method == method::CANCEL_REQUEST
                    && let Ok(p) = finx_rpc::params::<CancelParams>(params)
                {
                    self.cancel(&p.id, conn);
                }
            }
            Kind::Response { .. } => {}
            Kind::Invalid => conn.send_error(
                message.id.as_ref(),
                &RpcError::invalid_request("not a request, notification or response"),
            ),
        }
    }

    fn encoder(&self, _conn: &ConnHandle) -> Box<dyn Encoder> {
        Box::new(NativeEncoder)
    }

    fn on_closed(&self, _conn: &ConnHandle) {
        for (_, task) in self.running.lock().drain() {
            task.abort();
        }
    }
}

struct NativeEncoder;

impl Encoder for NativeEncoder {
    fn encode(&mut self, item: Outgoing, out: &mut Vec<Bytes>) {
        match item {
            Outgoing::Event(frame) => out.push(frame.native().clone()),
            Outgoing::Frame(bytes) => out.push(bytes),
            Outgoing::Detached(params) => out.push(Bytes::from(finx_rpc::notification(
                method::SESSION_DETACHED,
                &params,
            ))),
            Outgoing::Control(_) => {}
        }
    }
}
