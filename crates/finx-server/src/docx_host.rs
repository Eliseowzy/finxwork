//! Writing .docx through the desktop app (word-design §2): the engine's save is only in its
//! JavaScript, so a connection of the desktop app's calls `docx/host` and the kernel sends it
//! `docx/serialize` requests. The bytes travel in files.

use finx_protocol::api::DocxSerializeParams;
use finx_protocol::api::DocxSerializeResult;
use finx_protocol::api::method;
use finx_rpc::Id;
use finx_rpc::RpcError;
use parking_lot::Mutex;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::oneshot;

use crate::conn::ConnHandle;

#[derive(Debug, thiserror::Error)]
pub(crate) enum DocxHostError {
    #[error("保存 Word 文档需要 FinxWork 桌面端")]
    NoHost,
    #[error("the desktop app left before writing the document")]
    Disconnected,
    #[error("the desktop app took longer than {0:?} to write the document")]
    Timeout(Duration),
    #[error("the desktop app could not write the document: {0}")]
    Failed(String),
}

type Answer = Result<DocxSerializeResult, String>;

/// One `docx/host` connection and its requests waiting for an answer.
pub(crate) struct HostLink {
    id: u64,
    conn: ConnHandle,
    next: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Answer>>>,
}

impl HostLink {
    pub(crate) fn new(conn: ConnHandle) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            conn,
            next: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// A response from the host; one to a request no longer waited for is dropped.
    pub(crate) fn answer(&self, id: &Id, result: Result<&RawValue, &RpcError>) {
        let Id::Int(n) = id else { return };
        let Some(tx) = self.pending.lock().remove(n) else { return };
        let answer = match result {
            Ok(raw) => serde_json::from_str(raw.get()).map_err(|err| format!("a malformed answer: {err}")),
            Err(err) => Err(err.message.clone()),
        };
        let _ = tx.send(answer);
    }

    /// The host left: what waits on it fails.
    pub(crate) fn close(&self) {
        self.pending.lock().clear();
    }
}

/// The current host, if any: the one that registered last.
#[derive(Default)]
pub(crate) struct DocxHost {
    current: Mutex<Option<Arc<HostLink>>>,
}

impl DocxHost {
    pub(crate) fn set(&self, link: Arc<HostLink>) {
        if let Some(before) = self.current.lock().replace(link) {
            before.close();
        }
    }

    /// Unregisters `link`, unless a later host has replaced it.
    pub(crate) fn remove(&self, link: &HostLink) {
        let mut current = self.current.lock();
        if current.as_ref().is_some_and(|c| c.id == link.id) {
            current.take();
        }
    }

    #[cfg(test)]
    pub(crate) fn has_host(&self) -> bool {
        self.current.lock().is_some()
    }

    /// Has the host write `out` from the source .docx and the Yrs state (and the engine's peer
    /// metadata, when given); returns how many bytes it wrote. The caller checks the file.
    #[allow(dead_code, reason = "docx/save and docx_view call it")]
    pub(crate) async fn serialize_docx(
        &self,
        source: &Path,
        state: &Path,
        metadata: Option<&Path>,
        out: &Path,
        timeout: Duration,
    ) -> Result<u64, DocxHostError> {
        let link = self.current.lock().clone().ok_or(DocxHostError::NoHost)?;
        if link.conn.queue.is_closed() {
            return Err(DocxHostError::NoHost);
        }
        let n = link.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        link.pending.lock().insert(n, tx);
        let params = DocxSerializeParams {
            source_path: source.to_path_buf(),
            state_path: state.to_path_buf(),
            out_path: out.to_path_buf(),
            metadata_path: metadata.map(Path::to_path_buf),
        };
        link.conn.send(finx_rpc::request(&Id::Int(n), method::DOCX_SERIALIZE, &params));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result.bytes),
            Ok(Ok(Err(message))) => Err(DocxHostError::Failed(message)),
            Ok(Err(_)) => Err(DocxHostError::Disconnected),
            Err(_) => {
                link.pending.lock().remove(&n);
                Err(DocxHostError::Timeout(timeout))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use finx_core::FinxHome;
    use serde_json::Value;
    use serde_json::json;
    use tokio::io::AsyncBufReadExt;
    use tokio::io::AsyncWriteExt;

    use crate::native::NativeProtocol;
    use crate::server::Server;
    use crate::server::ServerOptions;

    type Lines = tokio::io::Lines<tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>;

    /// A server and a stand-in desktop app that has called `docx/host`.
    async fn hosted() -> (tempfile::TempDir, Server, Lines, tokio::io::WriteHalf<tokio::io::DuplexStream>, tokio::task::JoinHandle<()>) {
        let dir = tempfile::tempdir().unwrap();
        let home = FinxHome::new(dir.path().join("home"));
        home.ensure().unwrap();
        let server = Server::new(ServerOptions {
            home,
            cwd: dir.path().to_path_buf(),
            overrides: Vec::new(),
            mcp_servers: Vec::new(),
            doc_worker: finx_docs::Launcher::Thread,
        })
        .unwrap();
        let (client, ours) = tokio::io::duplex(1 << 20);
        let (server_reads, server_writes) = tokio::io::split(ours);
        let connection = tokio::spawn(crate::conn::run_connection(server.clone(), server_reads, server_writes, NativeProtocol::new(server.clone())));
        let (client_reads, mut writes) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_reads).lines();
        assert!(!server.0.docx_host.has_host());
        for request in [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocol_version": finx_protocol::PROTOCOL_VERSION, "client_info": {"name": "test"}}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "docx/host"}),
        ] {
            writes.write_all(format!("{request}\n").as_bytes()).await.unwrap();
        }
        let _init = lines.next_line().await.unwrap().unwrap();
        let hosted: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(hosted, json!({"jsonrpc": "2.0", "id": 2, "result": {}}));
        assert!(server.0.docx_host.has_host());
        (dir, server, lines, writes, connection)
    }

    async fn serialize(server: &Server, timeout: Duration) -> Result<u64, DocxHostError> {
        server.0.docx_host.serialize_docx(Path::new("/s.docx"), Path::new("/s.state"), None, Path::new("/o.docx"), timeout).await
    }

    #[tokio::test]
    async fn without_a_host_there_is_no_saving() {
        let (_dir, server, lines, writes, connection) = hosted().await;
        drop((lines, writes));
        tokio::time::timeout(Duration::from_secs(5), connection).await.unwrap().unwrap();
        assert!(!server.0.docx_host.has_host());
        let err = serialize(&server, Duration::from_secs(1)).await.unwrap_err();
        assert!(matches!(err, DocxHostError::NoHost));
        assert_eq!(err.to_string(), "保存 Word 文档需要 FinxWork 桌面端");
    }

    #[tokio::test]
    async fn a_request_goes_to_the_host_and_its_answer_comes_back() {
        let (_dir, server, mut lines, mut writes, _connection) = hosted().await;
        let waiting = tokio::spawn({
            let server = server.clone();
            async move { serialize(&server, Duration::from_secs(5)).await }
        });
        let request: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["method"], "docx/serialize");
        assert_eq!(request["params"], json!({"source_path": "/s.docx", "state_path": "/s.state", "out_path": "/o.docx"}));
        let answer = json!({"jsonrpc": "2.0", "id": request["id"], "result": {"bytes": 4096}});
        writes.write_all(format!("{answer}\n").as_bytes()).await.unwrap();
        assert_eq!(waiting.await.unwrap().unwrap(), 4096);

        // An error answer is the host's message.
        let waiting = tokio::spawn({
            let server = server.clone();
            async move { serialize(&server, Duration::from_secs(5)).await }
        });
        let request: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let answer = json!({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32603, "message": "bad state"}});
        writes.write_all(format!("{answer}\n").as_bytes()).await.unwrap();
        assert!(matches!(waiting.await.unwrap(), Err(DocxHostError::Failed(m)) if m == "bad state"));
    }

    #[tokio::test]
    async fn a_host_that_does_not_answer_times_out_and_one_that_leaves_fails_the_wait() {
        let (_dir, server, mut lines, writes, connection) = hosted().await;
        let err = serialize(&server, Duration::from_millis(100)).await.unwrap_err();
        assert!(matches!(err, DocxHostError::Timeout(_)), "{err}");
        let _first = lines.next_line().await.unwrap().unwrap();

        let waiting = tokio::spawn({
            let server = server.clone();
            async move { serialize(&server, Duration::from_secs(5)).await }
        });
        let _second = lines.next_line().await.unwrap().unwrap();
        drop((lines, writes));
        tokio::time::timeout(Duration::from_secs(5), connection).await.unwrap().unwrap();
        assert!(matches!(waiting.await.unwrap(), Err(DocxHostError::Disconnected)));
        assert!(!server.0.docx_host.has_host());
    }
}
