import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT } from "../tools/lib/paths.mjs";
import { pushArgs, readReportCount } from "../tools/recheck/open-pr.mjs";

/**
 * `tools/recheck/open-pr.mjs` publishes the nightly demotions, and it exists
 * because the inline-shell version of it was wrong in a way CI could not show:
 *
 *   ! [rejected]  nightly/recheck-<date> -> nightly/recheck-<date>  (stale info)
 *
 * `--force-with-lease` with no expected value reads the local remote-tracking
 * ref, and a fresh checkout of the default branch has none for the nightly
 * branch - so creating the branch worked and *updating* it, on a second run of
 * the same day, always failed. The rig below is a real bare remote with two
 * clones for exactly that reason: the second clone is the fresh CI checkout.
 *
 * `gh` is a recording stub on PATH: no network, and the PR title is asserted,
 * because the title is what a reviewer reads first.
 */

const OPEN_PR = path.join(REPO_ROOT, "tools/recheck/open-pr.mjs");
const BRANCH = "nightly/recheck-2026-10-07";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare origin, one clone, and a `gh` stub that appends its argv to a log. */
function rig({ ghExit = 0, ghStderr = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-open-pr-"));
  const origin = path.join(dir, "origin.git");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "gh-args.log");
  mkdirSync(bin);
  spawnSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });

  const gh = path.join(bin, "gh");
  // One argument per line, with a CALL separator: joining argv with spaces
  // would make `--title "a b"` indistinguishable from two arguments.
  writeFileSync(
    gh,
    `#!/bin/sh\nprintf 'CALL\\n' >> "$GH_LOG"\nfor a in "$@"; do printf '%s\\n' "$a" >> "$GH_LOG"; done\nprintf '%s' "$GH_STDERR"\nprintf '%s' "$GH_STDOUT"\nexit "$GH_EXIT"\n`,
  );
  chmodSync(gh, 0o755);

  const clone = (name) => {
    const work = path.join(dir, name);
    git(dir, ["clone", origin, work]);
    git(work, ["config", "user.name", "Test"]);
    git(work, ["config", "user.email", "test@example.com"]);
    return work;
  };
  const work = clone("work");
  writeFileSync(path.join(work, "catalog.json"), "{\n  \"apps\": []\n}\n");
  mkdirSync(path.join(work, "data", "ir"), { recursive: true });
  writeFileSync(path.join(work, "data/ir/banking.json"), '{"confidence": "verified"}\n');
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "seed"]);
  git(work, ["push", "-q", "origin", "main"]);
  writeFileSync(
    path.join(work, "recheck.json"),
    `${JSON.stringify({ demotions: [{ file: "data/ir/banking.json", package: "a" }, { file: "data/ir/banking.json", package: "b" }] }, null, 2)}\n`,
  );

  const runOpenPr = (cwd, args = []) =>
    spawnSync(
      process.execPath,
      [OPEN_PR, "--branch", BRANCH, "--base", "main", "--report", "recheck.json", ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_LOG: log,
          GH_EXIT: String(ghExit),
          GH_STDERR: ghStderr,
          GH_STDOUT: "https://example.test/pull/1\n",
        },
      },
    );

  return {
    dir,
    origin,
    work,
    clone,
    log,
    runOpenPr,
    // Each call is the list of arguments gh was invoked with.
    ghCalls: () => {
      let text;
      try {
        text = readFileSync(log, "utf8");
      } catch {
        return [];
      }
      return text
        .split("CALL\n")
        .slice(1)
        .map((call) => call.replace(/\n$/, "").split("\n"));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The demotion a run is supposed to publish: an unstaged edit under data/. */
function demoteOne(work, value) {
  writeFileSync(path.join(work, "data/ir/banking.json"), `{"confidence": "${value}"}\n`);
}

test("open-pr creates the nightly branch, commits only data/, and titles the PR from the report", () => {
  const r = rig();
  try {
    demoteOne(r.work, "legacy");
    const result = r.runOpenPr(r.work);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(r.dir, ["ls-remote", r.origin, `refs/heads/${BRANCH}`]).split(/\s+/)[0],
      git(r.work, ["rev-parse", "HEAD"]),
      "the pushed branch must point at the new commit",
    );
    const touched = git(r.work, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    assert.deepEqual(touched, ["data/ir/banking.json"], "recheck.json must not be committed");
    const calls = r.ghCalls();
    assert.equal(calls.length, 1);
    const pm = (name) => calls[0][calls[0].indexOf(name) + 1];
    assert.equal(pm("--title"), "Nightly recheck: demote 2 entries");
    assert.equal(pm("--base"), "main");
    assert.equal(pm("--head"), BRANCH);
  } finally {
    r.cleanup();
  }
});

test("open-pr updates a nightly branch that a fresh checkout has never seen", () => {
  const r = rig();
  try {
    demoteOne(r.work, "legacy");
    assert.equal(r.runOpenPr(r.work).status, 0);

    // The next night's runner: a brand new clone of the default branch, with no
    // remote-tracking ref for the branch that already exists. This is the exact
    // shape that produced "! [rejected] ... (stale info)".
    const fresh = r.clone("fresh");
    writeFileSync(path.join(fresh, "recheck.json"), readFileSync(path.join(r.work, "recheck.json"), "utf8"));
    demoteOne(fresh, "legacy-since-recheck"); // its own --apply output
    const before = git(r.dir, ["ls-remote", r.origin, `refs/heads/${BRANCH}`]).split(/\s+/)[0];

    const result = r.runOpenPr(fresh);
    assert.equal(result.status, 0, `a second run on the same day must not fail: ${result.stderr}`);
    const after = git(r.dir, ["ls-remote", r.origin, `refs/heads/${BRANCH}`]).split(/\s+/)[0];
    assert.equal(after, git(fresh, ["rev-parse", "HEAD"]));
    assert.notEqual(after, before);
    assert.equal(r.ghCalls().length, 2, "the second run still has to ask gh for the PR");
    // Force is only allowed to fast-forward: the first night's demotion is still
    // in the history of the branch.
    assert.equal(git(r.origin, ["merge-base", "--is-ancestor", before, after]).length, 0, "history must be preserved");
  } finally {
    r.cleanup();
  }
});

test("open-pr does nothing when the replay wrote no changes", () => {
  const r = rig();
  try {
    const result = r.runOpenPr(r.work);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to publish/);
    assert.equal(r.ghCalls().length, 0, "a clean tree must not open a PR");
    assert.equal(git(r.dir, ["ls-remote", r.origin, `refs/heads/${BRANCH}`]), "");
  } finally {
    r.cleanup();
  }
});

test("a broken report or a gh failure is an error, never a reassuring message", () => {
  const r = rig({ ghExit: 1, ghStderr: "gh: authentication required\n" });
  try {
    // No demotions array: the old workflow printed "demote some entries".
    writeFileSync(path.join(r.work, "recheck.json"), '{"ok": true}\n');
    demoteOne(r.work, "legacy");
    const broken = r.runOpenPr(r.work);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /no demotions array/);

    writeFileSync(
      path.join(r.work, "recheck.json"),
      `${JSON.stringify({ demotions: [{ file: "data/ir/banking.json", package: "a" }] })}\n`,
    );
    const unauth = r.runOpenPr(r.work);
    assert.equal(unauth.status, 1, "a gh failure that is not 'already exists' must fail the job");
    assert.match(unauth.stderr, /authentication required/);
  } finally {
    r.cleanup();
  }
});

test("an already-open PR is not a failure", () => {
  const r = rig({ ghExit: 1, ghStderr: 'a pull request for branch "nightly/x" already exists\n' });
  try {
    demoteOne(r.work, "legacy");
    const result = r.runOpenPr(r.work);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already open/);
  } finally {
    r.cleanup();
  }
});

test("open-pr refuses to publish onto the base branch", () => {
  const r = rig();
  try {
    demoteOne(r.work, "legacy");
    const result = r.runOpenPr(r.work, ["--branch", "main", "--base", "main"]);
    assert.equal(result.status, 3, "a forced push onto the trunk must be impossible");
    assert.match(result.stderr, /only publishes to a dedicated branch/);
    assert.equal(
      git(r.dir, ["ls-remote", r.origin, "refs/heads/main"]).split(/\s+/)[0],
      git(r.work, ["rev-parse", "origin/main"]),
    );
  } finally {
    r.cleanup();
  }
});

test("pushArgs pins the lease to the SHA the remote reported", () => {
  assert.deepEqual(pushArgs({ branch: "nightly/recheck-2026-10-07", remoteSha: "" }), [
    "push",
    "origin",
    "refs/heads/nightly/recheck-2026-10-07",
  ]);
  assert.deepEqual(pushArgs({ branch: "nightly/recheck-2026-10-07", remoteSha: "abc123" }), [
    "push",
    "--force-with-lease=refs/heads/nightly/recheck-2026-10-07:abc123",
    "origin",
    "refs/heads/nightly/recheck-2026-10-07",
  ]);
});

test("readReportCount refuses a report it cannot count", () => {
  assert.throws(
    () => readReportCount(path.join(REPO_ROOT, "package.json"), "demotions"),
    /no demotions array/,
  );
  assert.throws(
    () => readReportCount(path.join(REPO_ROOT, "package.json"), "insertions"),
    /no insertions array/,
  );
});
