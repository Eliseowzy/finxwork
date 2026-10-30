//! Public connection management and model-directory notifications; product logic is elsewhere.
use crate::{
    conn::{ConnHandle, ConnId},
    server::Server,
};
use finx_protocol::api::method;
use finx_rpc::RpcError;
impl Server {
    pub(crate) fn watch_models(&self, conn: &ConnHandle) {
        self.0.model_watchers.lock().insert(conn.id, conn.clone());
    }
    pub(crate) fn forget_model_watcher(&self, id: ConnId) {
        self.0.model_watchers.lock().remove(&id);
    }
    pub(crate) fn models_changed(&self) {
        for conn in self.0.model_watchers.lock().values() {
            conn.send(finx_rpc::notification(
                method::MODELS_CHANGED,
                &serde_json::json!({}),
            ));
        }
    }
}
pub(crate) fn rpc_error(e: finx_connections::ConnectionError) -> RpcError {
    RpcError {
        code: -32000,
        message: e.message,
        data: Some(serde_json::json!({"kind":e.code})),
    }
}
