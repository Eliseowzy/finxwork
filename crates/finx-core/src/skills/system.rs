//! Skills built into finx (docs/desktop/customize-design.md §4.6). Their files are compiled in
//! and written to `~/.finx/skills/.system` the first time a process looks for skills; a marker
//! with the files' fingerprint skips the write until finx changes them. They are found after
//! every other root, so a user's skill of the same name wins.

use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

/// `(path in .system, content)`
const FILES: &[(&str, &str)] = &[
    ("skill-creator/LICENSE.txt", include_str!("system/skill-creator/LICENSE.txt")),
    ("skill-creator/SKILL.md", include_str!("system/skill-creator/SKILL.md")),
    ("skill-creator/UPSTREAM.md", include_str!("system/skill-creator/UPSTREAM.md")),
    ("skill-creator/agents/analyzer.md", include_str!("system/skill-creator/agents/analyzer.md")),
    ("skill-creator/agents/comparator.md", include_str!("system/skill-creator/agents/comparator.md")),
    ("skill-creator/agents/grader.md", include_str!("system/skill-creator/agents/grader.md")),
    ("skill-creator/assets/eval_review.html", include_str!("system/skill-creator/assets/eval_review.html")),
    ("skill-creator/eval-viewer/generate_review.py", include_str!("system/skill-creator/eval-viewer/generate_review.py")),
    ("skill-creator/eval-viewer/viewer.html", include_str!("system/skill-creator/eval-viewer/viewer.html")),
    ("skill-creator/references/schemas.md", include_str!("system/skill-creator/references/schemas.md")),
    ("skill-creator/scripts/__init__.py", include_str!("system/skill-creator/scripts/__init__.py")),
    ("skill-creator/scripts/aggregate_benchmark.py", include_str!("system/skill-creator/scripts/aggregate_benchmark.py")),
    ("skill-creator/scripts/package_skill.py", include_str!("system/skill-creator/scripts/package_skill.py")),
    ("skill-creator/scripts/quick_validate.py", include_str!("system/skill-creator/scripts/quick_validate.py")),
];
const MARKER: &str = ".marker";

/// The directory below the user's skills that holds them.
pub fn dir(finx_home: &Path) -> PathBuf {
    finx_home.join("skills").join(".system")
}

fn fingerprint() -> String {
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    for (path, content) in FILES {
        context.update(path.as_bytes());
        context.update(&[0]);
        context.update(content.as_bytes());
        context.update(&[0]);
    }
    context.finish().as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes the built-in skills under `finx_home` once per process (and only when they changed).
pub fn ensure(finx_home: &Path) {
    static DONE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let done = DONE.get_or_init(|| Mutex::new(HashSet::new()));
    if !done.lock().unwrap_or_else(|e| e.into_inner()).insert(finx_home.to_path_buf()) {
        return;
    }
    if let Err(err) = write(finx_home) {
        tracing::warn!(%err, "cannot write the built-in skills");
    }
}

fn write(finx_home: &Path) -> io::Result<()> {
    let target = dir(finx_home);
    let expected = fingerprint();
    if std::fs::read_to_string(target.join(MARKER)).is_ok_and(|m| m.trim() == expected) {
        return Ok(());
    }
    // Write beside, then swap, so a reader never sees half of them.
    let staging = target.with_file_name(format!(".system.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    for (path, content) in FILES {
        let file = staging.join(path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(file, content)?;
    }
    std::fs::write(staging.join(MARKER), format!("{expected}\n"))?;
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&staging, &target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_bundle_and_skips_unchanged_files() {
        let home = tempfile::tempdir().unwrap();
        write(home.path()).unwrap();
        let skill = dir(home.path()).join("skill-creator");
        assert!(skill.join("scripts/aggregate_benchmark.py").is_file());
        assert!(skill.join("eval-viewer/viewer.html").is_file());
        assert!(skill.join("LICENSE.txt").is_file());
        assert!(!skill.join("scripts/run_eval.py").exists());
        assert_eq!(std::fs::read_to_string(dir(home.path()).join(MARKER)).unwrap().trim(), fingerprint());
        std::fs::write(skill.join("SKILL.md"), "local edit").unwrap();
        write(home.path()).unwrap();
        assert_eq!(std::fs::read_to_string(skill.join("SKILL.md")).unwrap(), "local edit");
    }

    #[test]
    fn an_upgrade_replaces_old_resources_but_preserves_user_skills() {
        let home = tempfile::tempdir().unwrap();
        let builtin = dir(home.path()).join("skill-creator/SKILL.md");
        let personal = home.path().join("skills/skill-creator/SKILL.md");
        for file in [&builtin, &personal] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "old skill").unwrap();
        }
        let stale = builtin.with_file_name("removed-script.py");
        std::fs::write(&stale, "old resource").unwrap();
        std::fs::write(dir(home.path()).join(MARKER), "old\n").unwrap();

        ensure(home.path());
        assert!(std::fs::read_to_string(builtin).unwrap().contains("name: skill-creator"));
        assert!(!stale.exists());
        assert_eq!(std::fs::read_to_string(personal).unwrap(), "old skill");
    }
}
