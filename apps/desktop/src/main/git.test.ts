import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitBranch } from "./git.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "finx-git-"));

test("a branch, from a folder deep in the repository", async () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feat/env\n");
  fs.mkdirSync(path.join(repo, "a", "b"), { recursive: true });
  assert.equal(await gitBranch(path.join(repo, "a", "b")), "feat/env");
});

test("a detached HEAD gives the commit's short id", async () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "46d3185e0f1c2b3a4d5e6f708192a3b4c5d6e7f8\n");
  assert.equal(await gitBranch(repo), "46d3185");
});

test("a worktree's .git file names its git directory", async () => {
  const root = tmp();
  const gitDir = path.join(root, "main", ".git", "worktrees", "wt");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
  fs.mkdirSync(path.join(root, "wt"));
  fs.writeFileSync(path.join(root, "wt", ".git"), "gitdir: ../main/.git/worktrees/wt\n");
  assert.equal(await gitBranch(path.join(root, "wt")), "wt-branch");
});

test("outside a repository, none", async () => {
  assert.equal(await gitBranch(tmp()), null);
});
