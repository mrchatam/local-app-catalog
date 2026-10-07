#!/usr/bin/env node
/**
 * Curation web UI: a local form that writes catalog entries through the same
 * rules CI applies. No framework, no build step, no network - a single
 * dependency-free node:http server bound to loopback.
 *
 *   npm run curate            # http://127.0.0.1:5174
 *   node tools/curate/server.mjs --port 8080
 *
 * The browser form POSTs to /api/propose (validate + show the diff) and only
 * POSTs to /api/apply when the contributor presses "Write to data/". Both
 * endpoints share tools/curate/lib.mjs with the headless CLI, so the two paths
 * cannot drift apart.
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { KNOWN_STORES } from "../lib/paths.mjs";
import { UsageError, need, needInt, usageGuard } from "../lib/args.mjs";
import {
  catalogPath,
  loadCatalog,
  normalizeEntry,
  orderEntry,
  relCatalogPath,
  renderPrBody,
  renderPrCommands,
  stageEntry,
  unifiedDiff,
  validateEntry,
} from "./lib.mjs";

const USAGE = `usage: node tools/curate/server.mjs [--port 5174] [--host 127.0.0.1]

The server writes to data/ with no authentication, so --host must be a loopback
address. Exit codes: 0 stopped cleanly, 1 could not start, 3 usage error.`;

/**
 * The curator writes catalog files with no auth, so the documented "loopback
 * only" rule is enforced rather than assumed: `--host 0.0.0.0` would publish a
 * file-writing endpoint to the whole network.
 */
function assertLoopbackHost(host) {
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return host;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return host;
  throw new UsageError(
    `--host must be a loopback address, got "${host}" (see SECURITY.md: the curator writes to data/ unauthenticated)`,
  );
}

function parseArgs(argv) {
  const opts = { port: 5174, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--port":
        opts.port = needInt("--port", argv[++i], { min: 1, max: 65535 });
        break;
      case "--host":
        opts.host = assertLoopbackHost(need("--host", argv[++i]));
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

const MAX_BODY = 64 * 1024;

/** An error that already knows the HTTP status the client deserves. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Read a request body, refusing anything over MAX_BODY. The oversized case
 * stops reading and lets the caller answer 413 before the socket closes -
 * destroying the request here means the client only ever sees a broken pipe.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        settled = true;
        req.pause();
        reject(new HttpError(413, `request body larger than ${MAX_BODY} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res, status, payload, { close = false } = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...(close ? { connection: "close" } : {}),
  });
  res.end(body, close ? () => res.destroy() : undefined);
}

/** Same defaults the CLI applies, so both paths produce identical entries. */
function withDefaults(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const out = { ...entry };
  if (!out.confidence) out.confidence = "community";
  if (!out.added_at) out.added_at = today;
  if (!out.added_by) out.added_by = "@anonymous";
  return orderEntry(out);
}

/** Validate + stage in memory, then report everything the reviewer needs. */
function proposal(entry, { apply }) {
  const repo = loadRepo();
  const verdict = validateEntry(entry, { repo });
  if (!verdict.ok) {
    return { ok: false, applied: false, errors: verdict.errors, warnings: verdict.warnings };
  }

  const staged = stageEntry(entry, { apply });
  const diff = unifiedDiff({
    before: staged.before,
    after: staged.after,
    from: `a/${staged.file}`,
    to: `b/${staged.file}`,
  });
  const result = validateRepo(loadRepo());
  const repoErrors = result.errors.filter((f) => f.where === staged.file);
  return {
    ok: repoErrors.length === 0,
    applied: apply,
    entry,
    file: staged.file,
    changed: staged.changed,
    diff,
    errors: [...verdict.errors, ...repoErrors.map((e) => `${e.code} ${e.where}: ${e.message}`)],
    warnings: verdict.warnings,
    prCommands: renderPrCommands([entry]),
    prBody: renderPrBody({ entries: [entry], validation: verdict.warnings, diff, result }),
  };
}

function state() {
  const repo = loadRepo();
  return {
    countries: repo.index.countries,
    categories: repo.index.categories,
    stores: KNOWN_STORES,
    counts: Object.fromEntries(
      repo.countries.map((c) => [
        c.code,
        Object.fromEntries(c.files.map((f) => [f.doc.category, (f.doc.apps ?? []).length])),
      ]),
    ),
    existing: Object.fromEntries(
      repo.countries.flatMap((c) =>
        c.files.flatMap((f) => (f.doc.apps ?? []).map((a) => [a.package, { country: c.code, category: f.doc.category }])),
      ),
    ),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    const body = PAGE;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, state());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/check") {
    const payload = JSON.parse((await readBody(req)) || "{}");
    const entry = normalizeEntry(payload.entry ?? payload);
    sendJson(res, 200, { ...proposal(withDefaults(entry), { apply: false }), entry });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/apply") {
    const payload = JSON.parse((await readBody(req)) || "{}");
    const entry = withDefaults(normalizeEntry(payload.entry ?? payload));
    const out = proposal(entry, { apply: true });
    if (out.applied && out.ok) {
      console.error(`wrote ${out.file}: ${entry.package}`);
    }
    sendJson(res, out.ok ? 200 : 422, out);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    const country = (url.searchParams.get("country") ?? "").toLowerCase();
    const rawCategory = url.searchParams.get("category") ?? "";
    // Both halves are path segments, so both are pattern-checked. Without this,
    // `category=../../package` walked out of data/ and read any JSON file on
    // disk through loadCatalog().
    if (!/^[a-z]{2}$/.test(country) || !/^[a-z][a-z0-9_-]{0,31}$/.test(rawCategory)) {
      sendJson(res, 400, {
        error: "country (2 letters) and category (lowercase identifier) are required",
      });
      return;
    }
    if (!existsSync(catalogPath(country, rawCategory))) {
      sendJson(res, 404, { error: `no catalog for ${country.toUpperCase()}/${rawCategory}` });
      return;
    }
    sendJson(res, 200, {
      file: relCatalogPath(country, rawCategory),
      doc: loadCatalog(country, rawCategory),
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/** Start the server; returns the listening http.Server so tests can close it. */
export function start({ port = 5174, host = "127.0.0.1", quiet = false } = {}) {
  assertLoopbackHost(host);
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 400;
      const payload = { ok: false, errors: [err.message], warnings: [] };
      if (res.headersSent) res.destroy();
      else sendJson(res, status, payload, { close: status === 413 });
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use; pass --port <n>`);
      process.exit(1);
    }
    console.error(`curate server failed: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    if (quiet) return;
    console.log(`LocalAppCatalog curator on http://${host}:${port}`);
    console.log("read the rules in data/schema.json; nothing is written until you press Write");
  });
  return server;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LocalAppCatalog curator</title>
<style>
  :root { --bg:#0f1116; --panel:#171a21; --line:#262b36; --fg:#e7e9ee; --dim:#8b93a5;
          --ok:#3fb950; --bad:#f85149; --warn:#d29922; --accent:#4493f8; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; }
  header h1 { font-size:16px; margin:0; }
  header span { color:var(--dim); font-size:12px; }
  main { display:grid; grid-template-columns:minmax(320px,420px) 1fr; gap:0; height:calc(100vh - 53px); }
  form, section { padding:16px 20px; overflow:auto; }
  form { border-right:1px solid var(--line); }
  label { display:block; margin:10px 0 4px; color:var(--dim); font-size:12px; }
  input, select { width:100%; padding:8px 10px; background:var(--panel); color:var(--fg);
                  border:1px solid var(--line); border-radius:6px; font:inherit; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  button { margin-top:14px; width:100%; padding:10px; border-radius:6px; border:1px solid var(--line);
           background:var(--panel); color:var(--fg); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  #verdict { margin-bottom:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); }
  .pill.ok { color:var(--ok); border-color:var(--ok); }
  .pill.bad { color:var(--bad); border-color:var(--bad); }
  .msg { margin:4px 0; }
  .msg.err { color:var(--bad); }
  .msg.warn { color:var(--warn); }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:12px; overflow:auto; white-space:pre-wrap; }
  pre.diff .add { color:var(--ok); }
  pre.diff .del { color:var(--bad); }
  pre.diff .hunk { color:var(--accent); }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:18px 0 8px; }
</style>
</head>
<body>
<header>
  <h1>LocalAppCatalog curator</h1>
  <span id="stats"></span>
</header>
<main>
  <form id="form" autocomplete="off">
    <div class="row">
      <div><label for="country">country</label><select id="country" name="country"></select></div>
      <div><label for="category">category</label><select id="category" name="category"></select></div>
    </div>
    <label for="package">package</label><input id="package" name="package" placeholder="com.example.app">
    <label for="label">label</label><input id="label" name="label" placeholder="Example App">
    <label for="evidence">evidence URL</label><input id="evidence" name="evidence" placeholder="https://store.example/app/com.example.app">
    <div class="row">
      <div><label for="confidence">confidence</label>
        <select id="confidence" name="confidence">
          <option value="community">community</option>
          <option value="verified">verified</option>
        </select></div>
      <div><label for="store">store</label><select id="store" name="store"><option value="">-</option></select></div>
    </div>
    <div class="row">
      <div><label for="added_by">added_by</label><input id="added_by" name="added_by" value="@anonymous"></div>
      <div><label for="verified_at">verified_at</label><input id="verified_at" name="verified_at" placeholder="YYYY-MM-DD"></div>
    </div>
    <button type="submit">Validate &amp; show diff</button>
    <button type="button" id="apply" class="primary" disabled>Write to data/</button>
  </form>
  <section>
    <div id="verdict"></div>
    <div id="detail"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let latest = null;

async function boot() {
  const state = await (await fetch("/api/state")).json();
  for (const c of state.countries) $("country").add(new Option(c, c));
  for (const c of state.categories) $("category").add(new Option(c, c));
  for (const s of state.stores) $("store").add(new Option(s, s));
  $("stats").textContent = state.countries.length + " countries / " + state.categories.length + " categories";
  $("package").addEventListener("input", checkExisting);
  $("country").addEventListener("change", checkExisting);
  latestState = state;
}

let latestState = null;
function checkExisting() {
  const pkg = $("package").value.trim();
  const hit = latestState && latestState.existing[pkg];
  if (hit) {
    show(false, ["\\"" + pkg + "\\" is already listed for " + hit.country + " in " + hit.category],
         [], "already present");
    $("apply").disabled = true;
  }
}

function payload() {
  const f = new FormData($("form"));
  const entry = {};
  for (const [k, v] of f.entries()) if (v) entry[k] = v;
  return { entry };
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

function show(ok, errors, warnings, note) {
  const html = [];
  html.push('<span class="pill ' + (ok ? "ok" : "bad") + '">' + (ok ? "valid" : "rejected") + "</span>");
  if (note) html.push(" " + note);
  for (const e of errors) html.push('<div class="msg err">error ' + esc(e) + "</div>");
  for (const w of warnings) html.push('<div class="msg warn">warn ' + esc(w) + "</div>");
  $("verdict").innerHTML = html.join("");
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function renderDiff(diff) {
  if (!diff) return "<p>no change</p>";
  const lines = diff.split("\\n").map((line) => {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++") ? "hunk" : "";
    return '<span class="' + cls + '">' + esc(line) + "</span>";
  });
  return '<pre class="diff">' + lines.join("\\n") + "</pre>";
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { json } = await post("/api/check", payload());
  latest = json;
  show(json.ok, json.errors, json.warnings, json.file ? "-> " + json.file : "");
  $("detail").innerHTML =
    "<h2>diff</h2>" + renderDiff(json.diff) +
    "<h2>pull request body</h2><pre>" + esc(json.prBody || "") + "</pre>" +
    "<h2>next steps</h2><pre>" + esc((json.prCommands || []).join("\\n")) + "</pre>";
  $("apply").disabled = !json.ok;
});

$("apply").addEventListener("click", async () => {
  if (!latest || !latest.ok) return;
  const { status, json } = await post("/api/apply", payload());
  latest = json;
  show(json.ok, json.errors, json.warnings, json.applied ? "written to " + json.file : "");
  $("detail").innerHTML = "<h2>diff</h2>" + renderDiff(json.diff);
  $("apply").disabled = true;
  if (status === 200) {
    boot();
  }
});

boot();
</script>
</body>
</html>
`;

// Tests import proposal/state/PAGE directly; the socket only opens when this
// file is the process entry point.
export { proposal, state, PAGE };

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  start(usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2))));
}
