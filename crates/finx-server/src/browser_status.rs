//! Which browsers are connected, for the clients that show it (the desktop app's settings):
//! `browser/status` answers and subscribes; `browser/changed` follows as hosts come and go.
//! `browser/site_icon` gives a site's icon for the lists of sites (browser-design §10.1).

use finx_protocol::api::BrowserSiteIconParams;
use finx_protocol::api::BrowserSiteIconResult;
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

    /// A site's icon, found the way a browser finds one and kept in `~/.finx/browser/icons`
    /// (`icon::site`): asked of the site when it is first shown; after that the kept one is given
    /// at once, and once it is a week old it is looked for again in the background. A site with
    /// none is kept too, so it is not asked each time; when no site answers (offline), nothing
    /// is kept and the next showing asks again. Only https sites on the internet have one to
    /// look for (`localhost` and IP addresses are left out). `cached` gives only what is kept.
    pub(crate) async fn site_icon(&self, params: BrowserSiteIconParams) -> BrowserSiteIconResult {
        let origin = params.origin.trim_end_matches('/');
        // A local page (http, a file) has no site to ask.
        if !origin.starts_with("https://") {
            return BrowserSiteIconResult::default();
        }
        let dir = self.0.home.site_icons_dir();
        let stored = if params.cached { finx_mcp::icon::load(&dir, origin) } else { finx_mcp::icon::site(&dir, origin).await };
        BrowserSiteIconResult { icon: stored.and_then(|s| s.data_uri()) }
    }
}
