#!/usr/bin/env python3
"""Start-up benchmark for `finx exec`, without a real model.

A local mock of an OpenAI-compatible endpoint stands in for the provider. For every run the
script records, relative to the moment the process is spawned:

  first_request  the first byte of the first model request reaches the mock
  exit           the process has exited (the mock answers with one short message)

`/usr/bin/true` is measured alongside as the cost of spawning any process at all. Several
binaries can be compared; they run interleaved so that background load affects them alike.
`--skills 0 25 200` repeats every binary with that many skills installed in the user's
`~/.agents/skills`, each with a description of typical length.

    cargo build --release
    python3 tools/bench/bench_startup.py --finx new=target/release/finx --finx old=/path/to/old/finx

Uses only the Python standard library. Runs in a temporary FINX_HOME and HOME (so the skills
of the machine stay out) and never contacts a real provider.
"""

import argparse
import os
import pathlib
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time

SSE = (
    'data: {"id":"b","object":"chat.completion.chunk","created":0,"model":"bench",'
    '"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n'
    'data: {"id":"b","object":"chat.completion.chunk","created":0,"model":"bench",'
    '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n'
    "data: [DONE]\n\n"
).encode()
RESPONSE = (
    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n"
    + f"Content-Length: {len(SSE)}\r\n\r\n".encode()
    + SSE
)


class Mock:
    """One request at a time on a blocking socket, so the arrival time is taken promptly."""

    def __init__(self):
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.arrivals = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            conn, _ = self.listener.accept()
            with conn:
                data = conn.recv(65536)
                arrived = time.time_ns()
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                head, _, body = data.partition(b"\r\n\r\n")
                length = 0
                for line in head.split(b"\r\n")[1:]:
                    name, _, value = line.partition(b":")
                    if name.strip().lower() == b"content-length":
                        length = int(value)
                while len(body) < length:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    body += chunk
                self.arrivals.append(arrived)
                conn.sendall(RESPONSE)


def install_skills(user: pathlib.Path, count: int):
    """`count` skills shaped like real ones: a folded description of about 700 characters."""
    for i in range(count):
        skill = user / ".agents" / "skills" / f"skill-{i:03}"
        (skill / "references").mkdir(parents=True)
        words = f"Builds, checks and ships widget pipeline number {i} for the team. "
        description = (words * 11)[:700]
        lines = "\n".join("  " + description[j : j + 70] for j in range(0, len(description), 70))
        body = f"# Skill {i}\n\nRead `references/guide.md` first.\n\n" + "Step text for the skill.\n" * 120
        (skill / "SKILL.md").write_text(f"---\nname: skill-{i:03}\ndescription: >-\n{lines}\n---\n{body}")
        (skill / "references" / "guide.md").write_text("Guide.\n")


def prepare(base: pathlib.Path, port: int, skills: int = 0, config: str = ""):
    home, proj, user = base / "home", base / "proj", base / "user"
    home.mkdir(parents=True)
    user.mkdir(parents=True)
    install_skills(user, skills)
    if config:
        (home / "config.toml").write_text(config)
    (home / "models.toml").write_text(
        f"""[providers.mock]
api = "openai-chat"
base_url = "http://127.0.0.1:{port}"
auth = "none"

[[providers.mock.models]]
id = "bench"
context_window = 128000
max_output_tokens = 8192
"""
    )
    # A typical project: a git checkout with an instruction file.
    (proj / ".git").mkdir(parents=True)
    (proj / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (proj / "AGENTS.md").write_text("Use 4-space indentation.\n")
    env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
    env.update(FINX_HOME=str(home), HOME=str(user), NO_COLOR="1")
    return env, proj


def run_once(cmd, env, cwd, mock=None):
    before = len(mock.arrivals) if mock else 0
    start = time.time_ns()
    proc = subprocess.run(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True)
    end = time.time_ns()
    if proc.returncode != 0:
        sys.exit(f"{cmd[0]} exited with {proc.returncode}:\n{proc.stderr.decode(errors='replace')}")
    row = {"exit": (end - start) / 1e6}
    if mock:
        if len(mock.arrivals) <= before:
            sys.exit("no request reached the mock server")
        row["first_request"] = (mock.arrivals[before] - start) / 1e6
    return row


def stats(values):
    values = sorted(values)
    p90 = values[min(len(values) - 1, round(0.9 * (len(values) - 1)))]
    return values[0], statistics.median(values), p90


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--finx", action="append", required=True, metavar="LABEL=PATH", help="binary to measure (repeatable)")
    parser.add_argument("--runs", type=int, default=50)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--skills", type=int, nargs="+", default=[0], metavar="N", help="skills installed (several values compare)")
    parser.add_argument("--config", default="", metavar="TOML", help="contents of config.toml in the temporary home, e.g. MCP servers")
    args = parser.parse_args()

    binaries = []
    for spec in args.finx:
        label, sep, path = spec.partition("=")
        if not sep:
            label, path = pathlib.Path(spec).name, spec
        binaries.append((label, str(pathlib.Path(path).resolve())))

    mock = Mock()
    with tempfile.TemporaryDirectory(prefix="finx-bench-") as tmp:
        setups = [(n, *prepare(pathlib.Path(tmp) / f"skills-{n}", mock.port, n, args.config)) for n in args.skills]
        cases = [
            (label if len(setups) == 1 else f"{label}/{n} skills", finx, env, proj)
            for label, finx in binaries
            for n, env, proj in setups
        ]
        floor = []
        results = {label: [] for label, _, _, _ in cases}
        for i in range(args.warmup + args.runs):
            row = run_once(["/usr/bin/true"], setups[0][1], setups[0][2])
            if i >= args.warmup:
                floor.append(row["exit"])
            shift = i % len(cases)
            for label, finx, env, proj in cases[shift:] + cases[:shift]:
                cmd = [finx, "exec", "-m", "mock/bench", "--permission-mode", "manual", "hello"]
                row = run_once(cmd, env, proj, mock)
                if i >= args.warmup:
                    results[label].append(row)

    width = max(16, *(len(label) + 1 for label in results))
    print(f"{'':<{width}} {'metric':<14} {'min':>7} {'p50':>7} {'p90':>7}   (ms, {args.runs} runs)")
    low, mid, high = stats(floor)
    print(f"{'/usr/bin/true':<{width}} {'exit':<14} {low:7.2f} {mid:7.2f} {high:7.2f}")
    for label, rows in results.items():
        for key in ("first_request", "exit"):
            low, mid, high = stats([r[key] for r in rows])
            print(f"{label:<{width}} {key:<14} {low:7.2f} {mid:7.2f} {high:7.2f}")


if __name__ == "__main__":
    main()
