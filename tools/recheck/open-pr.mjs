#!/usr/bin/env node
/**
 * Publish the nightly demotions: commit what `recheck --apply` just wrote, push
 * it to a branch, and open (or leave alone) the PR.
 *
 * This used to be inline `run:` shell in `.github/workflows/recheck.yml`, and
 * the part that broke was the push. `git push --force-with-lease` with no
 * expected value consults the local *remote-tracking* ref, and a fresh checkout
 * of the default branch has none for `nightly/recheck-<date>` - so re-running
 * on a day that already had a branch was rejected with "stale info" instead of
 * updating the PR. Logic that has already regressed once belongs somewhere with
 * a test, so it lives here and `tests/recheck-pr.test.mjs` drives it against a
 * real bare remote.
 *
 * Exit codes
 *   0  PR opened or updated - or there was nothing to publish
 *   1  git or gh failed
 *   3  usage error
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { UsageError, need, usageGuard } from "../lib/args.mjs";

const USAGE = `usage: node tools/recheck/open-pr.mjs --branch <name> --base <ref> --report <file> [--quiet]

Commit the demotions already written into data/, push them to --branch, and
open or update the PR against --base. The PR title quotes the demotion count
from --report - the same file the demotions were replayed from - so the title
can never disagree with the diff.

Exit codes
  0  PR opened or updated, or there was nothing to publish
  1  git or gh failed
  3  usage error`;

const COMMIT_MESSAGE = `Nightly recheck: demote entries no longer available

Entries whose country-scoped store returned a definite not-available answer
move from verified to legacy. legacy rows are kept for history and excluded
from consumer defaults.

Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>`;

const PR_BODY = `Daily automated re-verification of \`verified\` entries.

Each demotion below is backed by a definite "not available" answer from the
country-scoped store that originally vouched for the entry. Rows move
\`verified\` -> \`legacy\`; they are not deleted.

Please review the diff. A maintainer should spot-check anything surprising
before merging.

Generated with Codebuff.`;

/** Branches this tool must never commit onto, whatever the caller passes. */
const PROTECTED = new Set(["main", "master", "HEAD"]);

function parseArgs(argv) {
  const opts = { branch: null, base: null, report: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--branch":
        opts.branch = need(arg, argv[++i]);
        break;
      case "--base":
        opts.base = need(arg, argv[++i]);
        break;
      case "--report":
        opts.report = need(arg, argv[++i]);
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (!opts.branch) throw new UsageError("--branch is required");
  if (!opts.base) throw new UsageError("--base is required");
  if (!opts.report) throw new UsageError("--report is required");
  // The push is forced, so a mistyped --branch that lands on the trunk would
  // rewrite the trunk. Refuse before touching the remote.
  if (PROTECTED.has(opts.branch) || opts.branch === opts.base) {
    throw new UsageError(
      `--branch ${opts.branch} is the base branch; this tool only publishes to a dedicated branch`,
    );
  }
  return opts;
}

function run(command, args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(args) {
  const result = run("git", args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

/**
 * The count in the PR title comes from the report the demotions were replayed
 * from. Failing loudly here is the point: the old workflow fell back to the
 * string "some", which turned a broken report into a PR titled "demote some
 * entries" that a reviewer had no way to check against anything.
 */
export function readDemotionCount(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`--report ${file}: ${err.message}`);
  }
  if (!Array.isArray(doc?.demotions)) {
    throw new Error(`--report ${file} has no demotions array; it is not a recheck report`);
  }
  return doc.demotions.length;
}

/**
 * Push to a branch that may already exist on the remote, without ever
 * overwriting a commit we did not see: the lease is pinned to the SHA the
 * remote reports right now, rather than to a remote-tracking ref this clone may
 * not have. Exported so the test can pin the outcome without a shell.
 */
export function pushArgs({ branch, remoteSha }) {
  const ref = `refs/heads/${branch}`;
  return remoteSha
    ? ["push", `--force-with-lease=${ref}:${remoteSha}`, "origin", ref]
    : ["push", "origin", ref];
}

async function main() {
  const opts = usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2)));

  // A tree with nothing modified means the replay demoted nothing - every
  // finding had already been applied by hand or by an earlier PR. Not a failure.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty) {
    if (!opts.quiet) console.log("no changes after --apply; nothing to publish");
    return;
  }

  const count = readDemotionCount(opts.report);

  git(["config", "user.name", "local-app-catalog bot"]);
  git(["config", "user.email", "bot@users.noreply.github.com"]);

  // -B, not -b: re-running on the same day must reuse the branch instead of
  // failing on an existing local ref.
  const ref = `refs/heads/${opts.branch}`;
  const remoteSha = git(["ls-remote", "origin", ref]).split(/\s+/)[0] ?? "";
  git(["checkout", "-B", opts.branch]);
  if (remoteSha) {
    // Base the new commit on the branch's existing tip, not on the default
    // branch's HEAD. Without this the commit is a sibling of yesterday's one
    // and the forced push below *discards* it. A soft reset moves only the
    // branch ref - the demotions are still sitting unstaged in the working
    // tree - so there is nothing to conflict with, and the push becomes a
    // genuine fast-forward.
    git(["fetch", "--quiet", "origin", ref]);
    git(["reset", "--soft", "FETCH_HEAD"]);
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "lac-open-pr-"));
  try {
    const messageFile = path.join(scratch, "commit-msg.txt");
    const bodyFile = path.join(scratch, "pr-body.md");
    writeFileSync(messageFile, `${COMMIT_MESSAGE}\n`);
    writeFileSync(bodyFile, `${PR_BODY}\n`);

    // Only data/ is staged: recheck.json is scratch and must not ship.
    git(["add", "data"]);
    // A same-day re-run can reproduce the demotions that are already on the
    // branch; then there is a diff against the default branch but nothing new
    // to publish.
    if (!git(["diff", "--cached", "--name-only"])) {
      if (!opts.quiet) {
        console.log(`no changes beyond ${opts.branch}; nothing to publish`);
      }
      return;
    }
    git(["commit", "-F", messageFile]);

    git(pushArgs({ branch: opts.branch, remoteSha }));
    if (!opts.quiet) {
      console.log(
        remoteSha
          ? `updated ${opts.branch} (was ${remoteSha.slice(0, 12)})`
          : `created ${opts.branch}`,
      );
    }

    const pr = run("gh", [
      "pr",
      "create",
      "--title",
      `Nightly recheck: demote ${count} entries`,
      "--body-file",
      bodyFile,
      "--base",
      opts.base,
      "--head",
      opts.branch,
    ]);
    if (pr.status !== 0) {
      const detail = `${pr.stdout}\n${pr.stderr}`.trim();
      // An already-open PR is the normal outcome of a second run on the same
      // day: the push above already updated its branch. Anything else (auth,
      // network, bad base) must fail the job instead of printing a reassurance.
      if (!/already exists/i.test(detail)) {
        throw new Error(`gh pr create failed (${pr.status}): ${detail}`);
      }
      if (!opts.quiet) console.log(`PR for ${opts.branch} is already open; the push updated it`);
      return;
    }
    if (!opts.quiet) console.log(`opened PR: ${pr.stdout.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(`open-pr failed: ${err.message}`);
    process.exit(1);
  });
}
