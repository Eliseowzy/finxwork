//! The CDP commands finx-browser sends, and the events it reads (browser-design D-192,
//! D-210). The desktop app's embedded browser and the Chrome extension forward only these
//! commands: their shared browser end, `apps/chrome-extension/src/relay.js`, reads them from
//! `apps/chrome-extension/src/methods.js`, which is generated from this list, and the tests
//! below keep the two in step with the code.

/// Every command sent. The first group the embedded browser answers itself; the rest go
/// to a page's debugger.
pub const CDP_METHODS: &[&str] = &[
    // Browser level.
    "Browser.close",
    "Browser.setDownloadBehavior",
    "Target.activateTarget",
    "Target.attachToTarget",
    "Target.closeTarget",
    "Target.createTarget",
    "Target.detachFromTarget",
    "Target.getTargetInfo",
    "Target.getTargets",
    "Target.setDiscoverTargets",
    // Page level.
    "Accessibility.getFullAXTree",
    "DOM.describeNode",
    "DOM.focus",
    "DOM.getBoxModel",
    "DOM.getContentQuads",
    "DOM.getFrameOwner",
    "DOM.getNodeForLocation",
    "DOM.resolveNode",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.setFileInputFiles",
    "DOMSnapshot.captureSnapshot",
    "Fetch.continueRequest",
    "Fetch.enable",
    "Fetch.failRequest",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Log.enable",
    "Network.enable",
    "Page.captureScreenshot",
    "Page.createIsolatedWorld",
    "Page.enable",
    "Page.getFrameTree",
    "Page.getLayoutMetrics",
    "Page.getNavigationHistory",
    "Page.handleJavaScriptDialog",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Page.reload",
    "Page.setInterceptFileChooserDialog",
    "Page.stopLoading",
    "Runtime.callFunctionOn",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.getProperties",
    "Runtime.releaseObject",
    "Runtime.runIfWaitingForDebugger",
    "Target.setAutoAttach",
];

/// How many of [`CDP_METHODS`] are browser level.
pub const BROWSER_LEVEL: usize = 10;

/// Every event read.
pub const CDP_EVENTS: &[&str] = &[
    "Browser.downloadProgress",
    "Browser.downloadWillBegin",
    "Fetch.requestPaused",
    "Log.entryAdded",
    "Network.loadingFailed",
    "Network.loadingFinished",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Page.fileChooserOpened",
    "Page.frameDetached",
    "Page.frameNavigated",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
    "Page.javascriptDialogOpening",
    "Page.loadEventFired",
    "Page.navigatedWithinDocument",
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
    "Target.targetCrashed",
    "Target.targetCreated",
    "Target.targetDestroyed",
    "Target.targetInfoChanged",
];

/// The command list as a JavaScript module, for the browser end that the extension and the
/// desktop app share (§8.3.2, §8.4).
pub fn extension_module() -> String {
    let quoted = |list: &[&str]| list.iter().map(|m| format!("  \"{m}\",\n")).collect::<String>();
    format!(
        "// Generated from crates/finx-browser/src/methods.rs; do not edit. Regenerate with\n\
         // FINX_UPDATE_SNAPSHOTS=1 cargo test -p finx-browser methods.\n\
         \n\
         /** Browser-level commands, which the browser end answers itself. */\n\
         export const browserMethods = Object.freeze([\n{}]);\n\
         \n\
         /** Page-level commands, forwarded to a page's debugger; any other is refused (D-192). */\n\
         export const pageMethods = Object.freeze([\n{}]);\n",
        quoted(&CDP_METHODS[..BROWSER_LEVEL]),
        quoted(&CDP_METHODS[BROWSER_LEVEL..]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The `"Domain.name"` strings in the code of the crate, tests left out.
    fn names_in_code() -> BTreeSet<String> {
        let sources = [
            include_str!("cdp.rs"),
            include_str!("input.rs"),
            include_str!("launch.rs"),
            include_str!("lib.rs"),
            include_str!("policy.rs"),
            include_str!("pool.rs"),
            include_str!("router.rs"),
            include_str!("session.rs"),
            include_str!("snapshot.rs"),
        ];
        let mut names = BTreeSet::new();
        for source in sources {
            let code = source.split("#[cfg(test)]").next().unwrap_or(source);
            for quoted in code.split('"').skip(1).step_by(2) {
                let Some((domain, name)) = quoted.split_once('.') else { continue };
                let domain_ok = domain.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                    && domain.chars().all(|c| c.is_ascii_alphabetic());
                let name_ok = name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                    && name.chars().all(|c| c.is_ascii_alphabetic());
                if domain_ok && name_ok {
                    names.insert(quoted.to_string());
                }
            }
        }
        names
    }

    #[test]
    fn the_lists_match_the_code() {
        let used = names_in_code();
        let listed: BTreeSet<String> = CDP_METHODS.iter().chain(CDP_EVENTS).map(|m| m.to_string()).collect();
        let unlisted: Vec<_> = used.difference(&listed).collect();
        assert!(unlisted.is_empty(), "add to CDP_METHODS or CDP_EVENTS: {unlisted:?}");
        let unused: Vec<_> = listed.difference(&used).collect();
        assert!(unused.is_empty(), "no longer used: {unused:?}");
        for browser in &CDP_METHODS[..BROWSER_LEVEL] {
            assert!(browser.starts_with("Browser.") || browser.starts_with("Target."), "{browser}");
        }
    }

    /// The extension's copy must be this list. Run with FINX_UPDATE_SNAPSHOTS=1 to rewrite it.
    #[test]
    fn the_extension_copy_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/chrome-extension/src/methods.js");
        let module = extension_module();
        if std::env::var_os("FINX_UPDATE_SNAPSHOTS").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, module).unwrap();
            return;
        }
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(saved == module, "{} is out of date; rerun with FINX_UPDATE_SNAPSHOTS=1", path.display());
    }
}
