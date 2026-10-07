# Seed pipeline

These scripts produced the initial dataset and are kept so the provenance of
every seeded entry is reproducible. They are **not** the normal way to add data —
use `tools/curate/` for that. This pipeline exists to explain where the first
100 entries came from and to re-derive them offline.

## Why it is offline-reproducible

`verify.json` is the recorded output of the network probes. `gen_seed.py` reads
only that file, so the whole dataset can be regenerated on a machine with no
store access and no network at all:

```sh
python3 tools/seed/gen_seed.py        # rewrites data/<cc>/<category>.json
```

Running it against the committed `verify.json` reproduces the shipped `data/`
tree byte-for-byte. If it ever does not, either `verify.json` or the generator
changed, and the diff tells you which.

## The three stages

| File | Stage | Network? |
|------|-------|----------|
| `seed_spec.py` | Hand-curated candidate list: country → category → [(package, label)], each package observed in a country-gated store search. | no |
| `verify_seeds.py` | Probes every candidate against Google Play and the country-scoped stores; writes `verify.json`. | yes |
| `probe_more.py` | One-off: confirms guessed package ids by reading the real listing title. Nothing is written to `data/`. | yes |
| `gen_seed.py` | Turns `verify.json` into `data/<cc>/<category>.json`. | no |

## Confidence rules encoded in `gen_seed.py`

These mirror the validator, and the script is the reason the seed data passes it:

- An entry only lands if **some store returned `available`** for it.
- `confidence: "verified"` is set **only** when a country-scoped store — Café
  Bazaar, Myket, or RuStore (`COUNTRY_SCOPED`) — confirmed the package. Google
  Play's `gl=` parameter does **not** gate availability, so a Play listing is a
  discovery signal, not proof of local distribution.
- `store` is set only for those country-scoped confirmations, alongside
  `verified_at`.
- An entry whose Play listing 404s but whose local store listing resolves is
  kept, and the local store URL becomes its evidence.
- Anything with no resolving store is **dropped** and printed, not silently
  omitted. Two candidates were dropped this way: `com.banquemisr.mobilebank`
  (EG) and `com.alahli.alahli` (SA) — which is why no `data/sa/` folder exists
  even though `SA` is a registered country.

## Caveats recorded at seed time

- The runner lives in a datacenter. Café Bazaar and RuStore rate-limit it, and
  Myket returns 404 for anonymous probes. Where a country-scoped store could not
  be reached, the entry is `community`, not `verified` — an unreachable store is
  never treated as evidence either way.
- Labels come from the store listing title observed at probe time, not from a
  guess.
