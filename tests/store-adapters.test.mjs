/**
 * The Node tools and the Python store adapters have to agree about which stores
 * exist and which of them may promote an entry to `verified` - that rule is the
 * difference between "a listing exists somewhere" and "this app is local here".
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AUTHORITATIVE_STORES,
  KNOWN_STORES,
  REPO_ROOT,
  authoritativeStoresFor,
} from "../tools/lib/paths.mjs";
import { loadRepo } from "../tools/lib/load.mjs";
import { flattenEntries } from "../tools/lib/load.mjs";
import { pythonAdapterReport, pythonStoreAdapterSelfTest, readJson } from "./helpers.mjs";

const REPORT = pythonAdapterReport();

test("the Python adapter registry matches KNOWN_STORES exactly", () => {
  assert.deepEqual(Object.keys(REPORT.adapters).sort(), [...KNOWN_STORES].sort());
});

test("each adapter id has a module file behind it", () => {
  for (const id of KNOWN_STORES) {
    const file = path.join(REPO_ROOT, "fetch", "store_adapters", `${id}.py`);
    assert.ok(existsSync(file), `fetch/store_adapters/${id}.py is missing`);
  }
});

test("only country-scoped stores may promote an entry to verified", () => {
  const authoritative = Object.entries(REPORT.adapters)
    .filter(([, a]) => a.authoritative)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(authoritative, ["cafe_bazaar", "myket", "rustore"]);
  for (const [id, adapter] of Object.entries(REPORT.adapters)) {
    if (adapter.authoritative) {
      assert.equal(adapter.scope, "country", `${id} is authoritative but scope=${adapter.scope}`);
      assert.equal(adapter.resolve_by, "package", `${id} cannot resolve by package id`);
    }
    assert.ok(
      ["country", "region", "global"].includes(adapter.scope),
      `${id} has an unknown scope ${adapter.scope}`,
    );
  }
  // a country with no local storefront has no way to verify anything
  assert.deepEqual(REPORT.authoritative_for_TR, []);
  assert.deepEqual(REPORT.authoritative_for_IR, ["cafe_bazaar", "myket"]);
  assert.deepEqual(REPORT.authoritative_for_RU, ["rustore"]);
});

test("the catalog only cites stores the adapters actually implement", () => {
  const known = new Set(KNOWN_STORES);
  for (const { app } of flattenEntries(loadRepo())) {
    if (app.store) assert.ok(known.has(app.store), `unknown store "${app.store}" in ${app.package}`);
  }
});

test("verified entries cite a store that is country-scoped for their own country", () => {
  // "authoritative somewhere" is not enough: myket proves locality for Iran and
  // nothing at all about Turkey, so a verified TR entry citing myket is wrong.
  for (const { app, folderCode } of flattenEntries(loadRepo())) {
    if (app.confidence !== "verified") continue;
    assert.ok(app.verified_at, `${app.package} is verified without verified_at`);
    assert.ok(app.store, `${app.package} is verified without a store`);
    assert.ok(
      authoritativeStoresFor(folderCode).includes(app.store),
      `${app.package} (${folderCode}) is verified but cites ${app.store}, ` +
        `which only covers ${(AUTHORITATIVE_STORES[app.store] ?? []).join(", ") || "no country"}`,
    );
  }
});

test("the Node list of verifiable countries matches the Python registry", () => {
  const py = REPORT.authoritative_countries;
  assert.deepEqual(
    Object.fromEntries(Object.entries(AUTHORITATIVE_STORES).map(([id, cs]) => [id, cs])),
    py,
    "tools/lib/paths.mjs#AUTHORITATIVE_STORES and fetch/store_adapters are out of sync",
  );
  for (const cc of Object.values(py).flat()) {
    assert.deepEqual(
      authoritativeStoresFor(cc).sort(),
      Object.entries(py)
        .filter(([, countries]) => countries.includes(cc))
        .map(([id]) => id)
        .sort(),
      `Node and Python disagree about which stores can confirm ${cc}`,
    );
  }
});

test("every country named in the discovery query matrix is a registered country", () => {
  const queries = readJson("fetch/queries.json").queries;
  const index = readJson("data/index.json");
  const registered = new Set(index.countries);
  const countries = Object.keys(queries);
  assert.ok(countries.length > 0);
  for (const code of countries) {
    assert.ok(registered.has(code), `${code} has discovery queries but is not in data/index.json`);
  }
});

test("an HTTP 200 error page or soft-404 is never read as available", () => {
  // RuStore serves rate-limit notices with HTTP 200; without this guard a
  // throttled runner would report the app as present (or later, as absent).
  for (const result of pythonStoreAdapterSelfTest()) {
    assert.equal(
      result.status,
      result.expected,
      `HTTP 200 body ${JSON.stringify(result.detail)} was classified ${result.status}, expected ${result.expected}`,
    );
  }
});
