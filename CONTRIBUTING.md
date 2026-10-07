# Contributing

Thanks for helping keep the catalog correct. There are three ways to contribute,
in increasing order of effort.

## 1. Report a wrong entry

Open a **Report an app** issue. Include the package id and what is wrong
(wrong country, app is gone, it is actually a global app, evidence link broke).
That is the fastest fix and needs no local setup.

## 2. Add one or a few apps

Open an **Add an app** issue. Fill in the package id, label, country, category,
an https evidence link, and — if you can — the country-scoped store that carries
it. The form only asks for fields the validator enforces, so a complete issue is
almost always mergeable.

## 3. Add many apps, or a whole country

Use the curation tool. It validates every entry, writes files in the canonical
key order, keeps catalogs sorted, and produces a ready-to-merge diff and PR body
— so you do not have to know the format.

```sh
npm ci
npm run curate                 # web UI at http://localhost:5174
npm run curate:cli -- --help   # headless; great for scripted bulk adds
```

Then run the local gate before you push:

```sh
npm test          # unit tests for schema, rules, bundles, adapters
npm run validate  # schema + semantic rules over data/
```

### Adding a whole country

A country needs a folder `data/<cc>/` (lowercase) with at least one
`<category>.json`, the country code listed in `data/index.json#countries`, and a
known country-scoped store willing to verify entries — otherwise every entry can
only ever be `community`. Use the **Add a country** issue if you want to
volunteer as maintainer for it.

## The rules your entry must satisfy

These are enforced by `npm run validate` (see `tools/lib/rules.mjs`); the check
will fail your PR if they are violated, which is intentional.

- **Package ids** match `^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$` — identical to
  `data/schema.json`, and a test keeps the two from drifting.
- **No duplicates** within a country, even across categories.
- **No global apps as local.** Anything in `data/global.json` is a hard error
  (`GLOBAL_CONFLICT`). If you believe a global app is genuinely local somewhere,
  that is a discussion, not a data edit.
- **Evidence is an https URL.** No `http://`, no bare text.
- **`verified` requires a country-scoped store.** `store` must be one of the
  authoritative stores for that country, plus `verified_at`. There is no way to
  hand-mark something `verified` from a global store — the validator rejects it.
- **No future dates** in `added_at` / `verified_at`.

## What a good evidence link is

Prefer the **country-scoped store's own listing** over a news article or the
developer's homepage: it is the thing the nightly recheck will watch. Where only
a global store exists, a community entry with the Play listing is fine — just
leave it `community`.

## Reviewer notes

Maintainers merge when: the local gate is green, evidence is credible, and the
entry is a genuine *local* app (see #3 above). Demotions happen automatically
nightly; do not "re-verify" an entry by hand just to make a check pass — supply
fresh evidence instead.
