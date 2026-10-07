# Adding or fixing catalog data

Thanks! This template exists so a data pull request can be reviewed without
guessing. Delete the sections that do not apply.

## What changed

- Country / countries:
- Category / categories:
- Type: <!-- add entries / fix an entry / add a country / tooling only -->

## Checklist

- [ ] `npm ci && npm test` passes.
- [ ] `npm run validate` exits 0.
- [ ] Every new entry has an **https** evidence URL.
- [ ] No package from `data/global.json` was added as a local app.
- [ ] `confidence: verified` entries cite a **country-scoped** store for that
      country (Café Bazaar / Myket for IR, RuStore for RU) plus `verified_at`.
- [ ] I did not hand-edit generated bundles under `dist/` (they are built by CI).

## Evidence

For each new or changed package, one line: `package -> evidence URL` (the
country-scoped store listing if one exists, otherwise the global listing).

```

```

## Notes for the reviewer

<!-- Why is this app genuinely local to that country? Anything you could not
verify yourself? Delete if nothing to add. -->
