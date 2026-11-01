//! Which browsers are connected, for the clients that show it (the desktop app's settings):
//! `browser/status` answers and subscribes; `browser/changed` follows as hosts come and go.

use finx_protocol::api::BrowserStatus;
use finx_protocol::api::method;

use crate::conn::ConnHandle;
use crate::server::Server;

impl Server {
    pub(crate) fn browser_status(&self) -> BrowserStatus {
        let pool = &self.0.browser_pool;
        BrowserStatus {
            // One that cannot be used is shown too, with its problem, so clients can say what to update.
            extension: match (pool.has_extension(), self.0.extension.lock().clone()) {
                (true, status) => Some(status.unwrap_or_default()),
                (false, status) => status.filter(|s| s.problem.is_some()),
            },
            embedded: pool.has_host(),
        }
    }

    pub(crate) fn watch_browser(&self, conn: &ConnHandle) {
        self.0.browser_watchers.lock().insert(conn.id, conn.clone());
    }

    pub(crate) fn browser_changed(&self) {
        let status = self.browser_status();
        for conn in self.0.browser_watchers.lock().values() {
            conn.send(finx_rpc::notification(method::BROWSER_CHANGED, &status));
        }
    }
}
