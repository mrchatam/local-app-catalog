import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { catalogPath } from "../tools/curate/lib.mjs";
import { start } from "../tools/curate/server.mjs";
import { DATA_DIR, REPO_ROOT } from "../tools/lib/paths.mjs";

/**
 * The curator server has no authentication and writes straight into data/, so
 * its input handling is the security boundary. These tests pin the boundary:
 * what it must refuse (traversal, oversized bodies, non-loopback binding) and
 * what it must not do (write anything it rejected, answer 200 for a file it
 * does not have). Everything here binds an ephemeral loopback port and never
 * mutates data/.
 */

async function withServer(fn) {
  const server = start({ port: 0, quiet: true });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

test("catalogPath refuses to climb out of data/", () => {
  assert.equal(catalogPath("ir", "banking"), path.join(DATA_DIR, "ir", "banking.json"));
  const escapes = [
    ["zz", "../../package"],
    ["zz", "../../../etc/hostname"],
    ["..", "banking"],
    ["", "../../../package"],
  ];
  for (const [country, category] of escapes) {
    assert.throws(
      () => catalogPath(country, category),
      /must live under/,
      `${country}/${category} must not resolve outside data/`,
    );
  }
  // Containment alone is not enough: a slash-joined category can land back
  // inside data/ (`ir/banking/../../x` is `data/x`), so the HTTP layer also
  // rejects any category that is not a bare lowercase identifier.
  assert.equal(catalogPath("ir", "banking/../../package"), path.join(DATA_DIR, "package.json"));
});

test("the catalog endpoint refuses a category that would leave data/", async () => {
  await withServer(async (base) => {
    for (const category of ["../../package", "../../../etc/hostname", "banking/../../package"]) {
      const res = await fetch(`${base}/api/catalog?country=zz&category=${encodeURIComponent(category)}`);
      assert.equal(res.status, 400, category);
      const body = await res.json();
      assert.equal("doc" in body, false, "a rejected request must not carry a document");
      assert.ok(
        !JSON.stringify(body).includes("local-app-catalog"),
        "the rejection must not echo the file it refused to read",
      );
    }
  });
});

test("the catalog endpoint distinguishes a missing catalog from an empty one", async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/api/catalog?country=zz&category=nothinghere`);
    assert.equal(missing.status, 404);

    const real = await fetch(`${base}/api/catalog?country=ir&category=banking`);
    assert.equal(real.status, 200);
    const body = await real.json();
    assert.equal(body.file, "data/ir/banking.json");
    assert.ok(body.doc.apps.length > 0);
  });
});

test("an oversized proposal is refused with 413, not a dropped connection", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/check", JSON.stringify({ entry: { notes: "x".repeat(70 * 1024) } }));
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors.some((e) => /larger than/.test(e)));
  });
});

test("a malformed proposal body is a 400, not a crash", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/check", "{not json");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });
});

test("a rejected proposal never touches data/, even through /api/apply", async () => {
  const target = catalogPath("ir", "banking");
  const before = readFileSync(target, "utf8");
  await withServer(async (base) => {
    const res = await post(
      base,
      "/api/apply",
      JSON.stringify({
        entry: {
          package: "org.telegram.messenger",
          label: "Telegram",
          category: "banking",
          country: "IR",
          evidence: "https://example.test/x",
        },
      }),
    );
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.applied, false);
    assert.ok(body.errors.some((e) => /data\/global\.json/.test(e)));
  });
  assert.equal(readFileSync(target, "utf8"), before, "data/ must be byte-identical");
});

test("the server refuses to bind a non-loopback host", () => {
  assert.throws(() => start({ host: "0.0.0.0", quiet: true }), /loopback/);
  assert.throws(() => start({ host: "192.168.1.10", quiet: true }), /loopback/);
});

test("the curator server reports usage errors as exit 3 with no stack trace", () => {
  const cases = [
    [["--host", "--port", "5174"], /--host needs a value/],
    [["--port", "abc"], /--port needs an integer/],
    [["--port", "99999"], /--port needs an integer/],
    [["--host", "0.0.0.0"], /loopback/],
    [["--nope"], /unknown argument/],
  ];
  for (const [args, pattern] of cases) {
    const result = spawnSync(process.execPath, ["tools/curate/server.mjs", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 3, `${args.join(" ")} -> ${result.stderr}`);
    assert.match(result.stderr, pattern);
    assert.ok(!/\bat .*:\d+:\d+\)/.test(result.stderr), `stack trace leaked for ${args.join(" ")}`);
  }
});
