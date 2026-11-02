# Anthropic Skill Creator — Finx adaptation

Source: https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/skill-creator
Commit: ca45fc496a3436251f191354091d557da31c15b5
Retrieved: 2026-11-02
Copyright 2026 Anthropic, PBC. Licensed under Apache-2.0; the full license is in LICENSE.txt.

This directory preserves the upstream authoring, realistic evaluations, baseline comparisons,
grading, blind comparison, review, and iterative improvement workflow. It is adapted for Finx,
not an unmodified upstream release. It remains explicit-only, preserving Finx's prior built-in
invocation policy; `/skill:skill-creator` and the desktop action load it on demand.

Modified files:

- SKILL.md: Finx paths and tool interfaces, native subagents, actual available timing/usage,
  optional Python helpers, static offline review, native description evaluation, and validation.
- scripts/quick_validate.py: replaced PyYAML validation with read-only Finx discovery in an
  isolated temporary FINX_HOME. FINX_BIN selects a known desktop/terminal executable.
- scripts/package_skill.py: uses that native validator; requires no external Python packages.
- scripts/aggregate_benchmark.py: preserves unavailable measurements as null, excludes them
  from statistics, and reports actual run counts rather than assuming three runs.
- eval-viewer/generate_review.py: no lsof or process killing; handles nested run metadata,
  escapes embedded script data, and falls back to a free local port when necessary.
- eval-viewer/viewer.html: no remote fonts or SheetJS CDN; xlsx outputs remain downloadable;
  Finx wording and missing-measurement handling.
- assets/eval_review.html: removed external fonts for offline use.
- references/schemas.md: provider-neutral model example and unavailable-metric convention.

Not bundled: run_eval.py, improve_description.py, run_loop.py, generate_report.py, utils.py.
The automatic description optimizer depends on authenticated Claude Code and Claude-specific
stream events, so it would not measure Finx. The skill instead uses existing Finx sessions/tools.
The excluded report and utility modules are only used by those excluded scripts.

Runtime dependencies:

- Creating/editing a skill: the normal Finx model and file tools; no new service or account.
- Independent evaluations: Finx subagents when available, otherwise disclosed sequential checks.
- Statistics, offline HTML review, packaging, validation: optional Python 3.10+ standard library.
- Automated validation/packaging: the Finx executable on PATH or at FINX_BIN; no model requests.
- No Claude Code, Anthropic API key, Python packages, Node packages, or external CDN is required.
