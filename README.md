# LocalAppCatalog

A community-curated, **global-first** dataset of the *local* apps people actually
use in each country — banks, government services, wallets, ride-hailing,
messaging, telecom and shopping — plus the tooling that keeps it correct.

It exists for one job: **VPN split-tunneling clients** need to know which
apps must *bypass* the tunnel to keep working, because a local bank or transport
app often refuses to load over a foreign exit IP. Hard-coding that list per
country goes stale in weeks. This catalog is the maintained, verifiable source.

## What "local" means

Availability is **not** locality. An app being installable in a country (many
global apps are) does not make it a local app, and listing it as one is the main
way a catalog like this goes wrong.

Two rules encode that:

1. Only a **country-scoped store** can promote an entry from `community` to
   `verified`. The authoritative stores are Café Bazaar and Myket for Iran, and
   RuStore for Russia. Everything else — Google Play, AppGallery, APKPure,
   F-Droid, OneStore — is global or regional and can only *discover*, never
   *confirm*, locality.
2. `data/global.json` is a **negative catalog**: apps that are global and must
   never be selected as local (Google Wallet, WhatsApp, Telegram, PayPal, Amazon
   Shopping, …). The validator raises `GLOBAL_CONFLICT` if one appears in a
   country file, and every bundle ships the list so a client can subtract it.

## Repository layout

```
data/
  schema.json        JSON Schema for every file here ($id .../schema/v1/schema.json)
  index.json         the registry: which countries and categories exist
  global.json        the negative catalog (global apps)
  <cc>/<category>.json   the actual entries, lowercase country folder
fetch/
  play_availability.py   single source of truth for "is this app on Play?"
  discover.py            nomination-only discovery (never writes data/)
  store_adapters/        one interface, many stores (Play, Café Bazaar, RuStore,
                         AppGallery, APKPure, OneStore, Myket, F-Droid)
tools/
  validate/          CI validator (schema + semantic rules + optional store check)
  curate/            web UI + headless CLI that produce a ready-to-merge PR
  recheck/           nightly demoter: `verified` → `community` when a listing dies
  build/             deterministic release bundler
tests/               node --test suites for all of the above
```

## Consuming the dataset

Two ways, depending on how much you want to depend on the network.

**Directly from `data/`.** Read `data/index.json` for the country and category
registry, then `data/<cc>/<category>.json` (country folders are lowercase, the
`country` field inside is uppercase). Each file is `{ "apps": [ … ] }`. Only
entries with `confidence: "verified"` have been confirmed by a country-scoped
store; `community` entries are unconfirmed nominations. Exclude `legacy`.

**From a release.** A tagged release (`vYYYY.MM.DD`) publishes prebuilt bundles
on the Releases page, each byte-for-byte reproducible from its commit:

- `catalog-all.json` — every country in one file.
- `catalog-<cc>.json` — one self-contained bundle per country.
- `manifest.json` — tag, counts, artifact sizes and their sha256.
- `SHA256SUMS` — every artifact's hash in `sha256sum -c` format.

A country bundle looks like this (see `tools/lib/bundle.mjs` for the source of
truth — `format` is the bundle format version, independent of the data version):

```json
{
  "format": 1,
  "release": "v2026.10.07",
  "data_version": 1,
  "generated_from": "data/",
  "globals": ["com.whatsapp", "..."],
  "globals_note": "...",
  "country": "TR",
  "categories": ["banking", "..."],
  "counts": { "entries": 10, "active_entries": 10, "legacy_entries": 0, "categories": 5, "globals": 21 },
  "packages": { "banking": ["com.example.bank", "..."] },
  "entries": [ { "package": "...", "label": "...", "confidence": "verified", "store": "rustore", "...": "..." } ]
}
```

Rules a client should follow:

1. Build the bypass set from `packages` only. It already excludes `legacy`
   entries; `entries` carries the full provenance for display.
2. Subtract every id in `globals` from any candidate bypass set.
3. Pin a release tag and verify before use:
   `sha256sum -c SHA256SUMS`.
4. Never promote a `community` entry to `verified` on the client side; that is a
   data decision made in this repo.

To rebuild a release locally and get identical bytes, pin the clock:

```sh
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run build -- --tag vYYYY.MM.DD --validate
```

Without `SOURCE_DATE_EPOCH` the build omits `generated_at` entirely, so the same
commit still yields byte-identical output — only the pinned run stamps a time.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: use the curation tool
rather than hand-editing JSON, because it validates, sorts, and writes the PR
body for you.

```sh
npm ci
npm run curate            # web UI on http://localhost:5174
npm run curate:cli -- --help   # headless, scriptable
```

## Freshness and the nightly recheck

`.github/workflows/recheck.yml` runs nightly. It re-checks every `verified`
entry against the country-scoped store that confirmed it and **demotes** any
entry whose listing has disappeared, preserving provenance and recording why in
`notes`. It opens a PR; it never pushes to `main` directly. A blocked or
throttled runner is reported as *inconclusive*, never as proof an app is gone,
so a datacenter IP can never fail a contributor's change.

## License

Tooling is **MIT** ([LICENSE](LICENSE)); the data is **ODbL 1.0**
([LICENSE-DATA](LICENSE-DATA)). See those files for the exact terms.
