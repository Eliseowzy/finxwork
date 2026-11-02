#!/usr/bin/env python3
"""Finx adaptation: validate with the product's parser, without PyYAML.

Modified from Anthropic Skill Creator; see ../UPSTREAM.md. FINX_BIN may point
at the desktop's bundled executable. No provider requests or installs occur.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def validate_skill(skill_path):
    skill_path = Path(skill_path).resolve()
    skill_md = skill_path / "SKILL.md"
    if not skill_md.is_file():
        return False, "SKILL.md not found"
    executable = shutil.which(os.environ.get("FINX_BIN", "finx"))
    if not executable:
        return False, "Finx executable unavailable; set FINX_BIN or review in the desktop skill list."
    # A new home and cwd isolate this check from project trust, disabled names,
    # personal configuration and duplicate skill names. Only discovery runs.
    with tempfile.TemporaryDirectory(prefix="finx-skill-validate-") as scratch:
        env = {**os.environ, "FINX_HOME": str(Path(scratch) / "home")}
        command = [executable, "-c", "skills.enabled=true", "-c", "skills.other_apps=false",
                   "-c", "skills.paths=" + json.dumps([str(skill_path.parent)]),
                   "skills", "--all", "--json"]
        try:
            result = subprocess.run(command, cwd=scratch, env=env, capture_output=True,
                                    text=True, timeout=30)
            if result.returncode:
                return False, result.stderr.strip() or "Finx skill discovery failed"
            entries = json.loads(result.stdout)["skills"]
            entry = next((item for item in entries if Path(item["path"]).resolve() == skill_md), None)
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError) as error:
            return False, f"Cannot validate with Finx: {error}"
    if entry is None:
        return False, "Finx did not discover this skill"
    if entry["state"] == "invalid":
        return False, entry.get("detail", "Invalid skill")
    if entry.get("notes"):
        return False, "; ".join(entry["notes"])
    return True, "Skill is valid in Finx."


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 quick_validate.py <skill_directory>")
        sys.exit(1)
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
