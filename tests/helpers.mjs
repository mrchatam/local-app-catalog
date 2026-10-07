import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INDEX_PATH, REPO_ROOT } from "../tools/lib/paths.mjs";

/** Global apps named in the spec, whose package ids must never appear in a country catalog. */
export const CONFUSABLES = [
  { name: "Google Wallet", package: "com.google.android.apps.walletnfcrel" },
  { name: "PayPal", package: "com.paypal.android.p2pmobile" },
  { name: "Telegram", package: "org.telegram.messenger" },
  { name: "WhatsApp", package: "com.whatsapp" },
  { name: "MiniChat", package: "mini.video.chat" },
  { name: "Amazon", package: "com.amazon.mShop.android.shopping" },
];

export function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
}

/** A valid catalogue entry; override any field to build the case under test. */
export function entry(overrides = {}) {
  return {
    package: "com.example.localapp",
    label: "Example Local App",
    category: "banking",
    country: "IR",
    confidence: "community",
    added_by: "@fixture",
    added_at: "2026-01-01",
    evidence: "https://play.google.com/store/apps/details?id=com.example.localapp",
    ...overrides,
  };
}

/**
 * Build a throwaway data/ directory. `global.json` always comes from the real
 * repo (loadRepo reads it from GLOBAL_PATH), so global-conflict rules are tested
 * against the shipped negative catalog, not a copy.
 */
export function makeRepo(files, { index = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-test-"));
  const indexDoc = index ?? readJson("data/index.json");
  writeFileSync(path.join(dir, "index.json"), `${JSON.stringify(indexDoc, null, 2)}\n`);
  for (const [rel, doc] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function codes(result) {
  return result.findings.map((f) => f.code);
}

export function errorsByCode(result) {
  const out = new Map();
  for (const f of result.errors) out.set(f.code, [...(out.get(f.code) ?? []), f]);
  return out;
}

const PY_BRIDGE = `
import json, sys
sys.path.insert(0, "fetch")
from store_adapters import ADAPTERS, authoritative_for
print(json.dumps({
    "adapters": {
        i: {
            "authoritative": a.authoritative,
            "scope": a.scope,
            "resolve_by": a.resolve_by,
            "countries": a.countries,
        }
        for i, a in ADAPTERS.items()
    },
    # what each country-scoped store can confirm, as a flat map
    "authoritative_countries": {
        a.id: a.countries
        for a in ADAPTERS.values()
        if a.authoritative and a.resolve_by == "package"
    },
    "authoritative_for_IR": sorted(a.id for a in authoritative_for("IR")),
    "authoritative_for_RU": sorted(a.id for a in authoritative_for("RU")),
    "authoritative_for_TR": sorted(a.id for a in authoritative_for("TR")),
}))
`;

/** Ask the Python store-adapter registry what it knows (the Node side must stay in sync). */
export function pythonAdapterReport() {
  const stdout = execFileSync("python3", ["-c", PY_BRIDGE], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

/**
 * Classification rules for the HTTP-200 traps: a storefront that answers 200
 * with an error page or a "not found" page (soft 404) must never be read as
 * "the app is here". These run offline against a stubbed fetch, because the
 * real RuStore rate-limits the CI runner and cannot be relied on for a test.
 */
const PY_SELFTEST = `
import json, sys
sys.path.insert(0, "fetch")
import store_adapters.rustore as rustore
from store_adapters import ADAPTERS

PKG = "ru.sberbankmobile"
URL = "https://www.rustore.ru/catalog/app/" + PKG


class Fake:
    def __init__(self, status, body, url=URL, error=None):
        self.status, self.body, self.url, self.error = status, body, url, error

    @property
    def missing(self):
        return self.status == 404


def classify(status, body):
    rustore.fetch = lambda url, **kw: Fake(status, body)
    result = ADAPTERS["rustore"].check(PKG, "RU")
    return {"status": result.status, "detail": result.detail}


CALLS = [
    ("available", 200, "<html><title>RuStore</title>" + PKG + "</html>"),
    ("error", 200, "<html><head><title>\u041e\u0448\u0438\u0431\u043a\u0430 429</title></head></html>"),
    ("unknown", 200, "<html><title>RuStore</title>nothing here</html>"),
    ("unavailable", 404, "<html><title>404</title></html>"),
]
print(json.dumps({
    "cases": [
        {"expected": expected, **classify(status, body)}
        for expected, status, body in CALLS
    ]
}))
`;

/** Exercise the store adapters' HTTP-200 classification with a stubbed transport. */
export function pythonStoreAdapterSelfTest() {
  const stdout = execFileSync("python3", ["-c", PY_SELFTEST], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout).cases;
}

/**
 * The availability checker's exit-code contract, driven offline by stubbing the
 * adapter's check(). A definite 404 must be a *resolved* answer (exit 0),
 * because the Node validator reads exit 2 as "inconclusive" and would otherwise
 * turn real falsification evidence into a warning.
 */
const PY_AVAILABILITY_SELFTEST = `
import contextlib, io, json, sys
sys.path.insert(0, "fetch")
import play_availability as pa
from store_adapters import ADAPTERS
from store_adapters.base import (
    STATUS_AVAILABLE, STATUS_ERROR, STATUS_UNAVAILABLE, STATUS_UNKNOWN, CheckResult,
)


def stub(status):
    def check(package, country):
        return CheckResult(
            package=package, store="rustore", country=country.upper(),
            status=status, scope="country", evidence="https://example.test/x",
        )
    ADAPTERS["rustore"].check = check


def run(status):
    stub(status)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = pa.main(["--country", "ru", "--package", "ru.sberbankmobile",
                      "--store", "rustore", "--json"])
    payload = json.loads(buf.getvalue())
    return {
        "stub": status,
        "exit": rc,
        "verdict_status": payload["verdicts"][0]["status"],
        "country": payload["country"],
        "summary": payload["summary"],
    }


def usage(argv):
    try:
        pa.main(argv)
    except SystemExit as exc:
        return exc.code
    return 0


print(json.dumps({
    "resolved": [run(s) for s in (STATUS_AVAILABLE, STATUS_UNAVAILABLE)],
    "inconclusive": [run(s) for s in (STATUS_UNKNOWN, STATUS_ERROR)],
    "usage": {
        "unknown-store": usage(["--country", "RU", "--store", "nope", "--package", "a.b"]),
        "no-package": usage(["--country", "RU"]),
        "no-country": usage(["--package", "a.b"]),
    },
}))
`;

/** Exit codes and verdicts of fetch/play_availability.py with a stubbed store. */
export function pythonAvailabilitySelfTest() {
  const stdout = execFileSync("python3", ["-c", PY_AVAILABILITY_SELFTEST], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

/** The discovery planner is pure: ask it what jobs it would run, offline. */
const PY_DISCOVER_SELFTEST = `
import json, sys
sys.path.insert(0, "fetch")
import discover as d
from store_adapters import ADAPTERS

matrix = {
    "TR": {"banking": ["banka", "banka uygulamasi"], "rideshare": ["taksi"]},
    "IR": {"banking": ["bank"]},
}
jobs = d.build_jobs(matrix, ["TR", "IR"], ["banking", "rideshare"])
print(json.dumps({
    "jobs": [list(j) for j in jobs],
    "search_capable": sorted(i for i, a in ADAPTERS.items() if hasattr(a, "search")),
}))
`;

/** Which country/category/query jobs the discovery run would issue. */
export function pythonDiscoverPlan() {
  const stdout = execFileSync("python3", ["-c", PY_DISCOVER_SELFTEST], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}
