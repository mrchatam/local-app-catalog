# Gap register

Living list of everything missing, weak, or unverified in this repository.
Each item is either **open** or **done** with the evidence that closed it.
The audit runs in loops: enumerate → fix → re-run the gate → repeat until the
open list is empty.

## Gate

The definition of "clean" after any loop:

- `npm test` — all tests pass.
- `npm run validate` — exit 0, no errors.
- `node tools/build/cli.mjs --validate --quiet` twice → byte-identical output.
- `git status` — nothing unintentionally untracked.

## Loop log

| Loop | Commit | Found | Fixed |
|------|--------|-------|-------|
| 1 | `4b787e0` | Built the dataset, validator, curation tooling, CI. | — |
| 2 | `4043b63` | Non-reproducible builds, broken CI summary, tracked scratch output. | D1–D3 |
| 3 | `799b9f6` | No README/license/code-of-conduct, untested CLI exit codes, seed scripts buried in ignored scratch. | G1–G9, G11 |
| 4 | `b68f717` | npm package ships ODbL data without its licence text; `discover.py` crashes on bad flags; the availability exit-code contract was documented backwards; missing PR template, security policy, editor config. | G12–G18 |
| 4 | `3943d3a` | Value-taking flags swallowed the next flag (and `build --out --quiet` wrote a release into a directory literally named `--quiet`); an unregistered `--country` passed silently as clean; a non-numeric `--max-messages` silently disabled the cap; usage errors disagreed on their exit code; `curate --json` returned a weaker verdict than the human path. | G19–G23 |
| 5a | `2fd75e1` | The curator server read any JSON file on disk through a traversing `category`; its own flags swallowed each other and it exited 2 for usage errors; it could be bound to `0.0.0.0` despite documenting loopback-only; an oversized body killed the socket instead of answering 413; a missing catalog was reported as an empty one. | G24–G28 |
| 5b | `9f0e2a0` | `validate.yml` shipped a banner-prefixed "JSON" file because `npm run` prints its banner to stdout; the nightly push always failed with `--force-with-lease` "stale info" on any same-day re-run; a dispatch `inputs.tag` reached the shell unvalidated; two report parsers died on a broken file (one producing a PR titled "demote some entries"); the demotion PR would have re-probed stores, applying a different set than the report describes; and `checkout -B` + a forced push replaced the previous night's commit instead of extending it. | G29–G34 |
| 5c | `bafbbce` | The Python fetch CLIs still had the bugs audit loop 4 removed from the Node ones, plus one only Python could have: `discover.py` accepted unregistered countries/categories, `--all` was a union with the query matrix, its twin selection flags overrode each other silently; `play_availability.py` surfaced a typo'd `--from-catalog` as a traceback and let `--only-verified` silently check nothing; and a store authoritative for a *different* country over-claimed `authoritative: true` on its verdicts. | G36–G40 |

## Open items

| # | Gap | Why it matters | Status |
|---|-----|----------------|--------|
| G35 | No `tools/seed/` verification in CI | The seed proof (`gen_seed.py` reproduces `data/` byte-for-byte) ran once by hand during G11. | open |

## Done items

| # | Gap | Closed by |
|---|-----|-----------|
| G10 | No trace evidence entities / reviews / seed export | The trace graph now carries what the CLI can verify: a PASS review and a DONE transition on each of the ten tasks (the PENDING→DONE edge is illegal, so each task was walked through IN_PROGRESS), one evidence entity backing one claim via `claim-evidence`, and `trace seed export --strict -o trace/graph.json` (exported at `efa1fd4`) committed as the durable copy. The graph's D1–D4 cover availability-vs-locality, Play search, the negative global catalog, and the single-Python-implementation contract. |
| G36 | `discover.py` accepted a country or category the catalog registry does not carry | The Node validator got this in G20 (`needCountry` checks `data/index.json`), but the Python nominator was still the union of whatever a contributor typed. `--country XX` now exits 2 naming the registered set, and so does an unregistered `--category`. |
| G37 | `discover.py --all` was a union with the query matrix, not the catalog contract | A stray query-matrix key (a country not in `data/index.json`) would nominate candidates no consumer reads. `--all` is now the intersection with the registry and warns on the keys it skips. |
| G38 | `discover.py`'s twin selection flags overrode each other silently | `--countries IR --country TR` ran only IR; nothing in the output said the other flag was dropped. Both flags now merge (first spelling wins, duplicates dropped), and likewise `--category`+`--categories`. |
| G39 | `play_availability.py` failed ugly on catalog input, and `--only-verified` could silently check nothing | A typo'd `--from-catalog` surfaced as a `FileNotFoundError` traceback (`SystemExit(str)` semantics: a diagnostic message, but through the wrong door); it now exits 1 with a readable message and no traceback. `--only-verified` without `--from-catalog`, or against a catalog with no `verified` rows, is a usage error instead of an empty run that exits 0 as "all resolved". |
| G40 | A verdict over-claimed authority outside the store's countries | `play_availability.py --store myket --country TR` labelled an available verdict `authoritative: true` and let it win the deciding slot — a store only vouches for locality inside the countries it serves. Authority is now scoped to `supports_country`; elsewhere the positive answer is a hint, the verdict says `authoritative: false`, and ranking is authoritative-here > available > authoritative-elsewhere. |
| G1 | No `README.md` | [README.md](README.md) — full consumption contract, bundle format, `legacy` exclusion, checksum verification, tag pinning, reproducible rebuild command. |
| G2 | No `LICENSE` / `LICENSE-DATA` | [LICENSE](LICENSE) (MIT, tooling) and [LICENSE-DATA](LICENSE-DATA) (full canonical ODbL 1.0 text, data). |
| G3 | No `CONTRIBUTING.md` | [CONTRIBUTING.md](CONTRIBUTING.md) — three contribution paths, the enforced rules, what good evidence is. The `config.yml` link now resolves. |
| G4 | `config.yml` used the placeholder `OWNER` | Both links now point at `localappcatalog/local-app-catalog`, matching the `repository`/`homepage` fields in package.json. |
| G5 | No `CODE_OF_CONDUCT.md` | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), Contributor Covenant 2.1, with a global-catalog-specific note. |
| G6 | `package.json` lacked repository/homepage/bugs/author/keywords | Added, plus a `files` allow-list so a future publish ships data + lib only. |
| G7 | No CLI-level test for the build clock | `tests/cli.test.mjs`: omits `generated_at` when unpinned, derives tag + timestamp from `SOURCE_DATE_EPOCH`, byte-identical across pinned runs, rejects a non-numeric clock, rejects a malformed tag, `--validate` refuses a broken catalog. |
| G8 | No test for validate CLI exit codes | `tests/cli.test.mjs`: exit 0 with a clean report on the shipped catalog, exit 1 on a `GLOBAL_CONFLICT`, exit 1 on an unknown argument. |
| G9 | No test for recheck CLI exit codes | `tests/cli.test.mjs`: exit 3 on three usage errors, `--help` documents the codes, and `DEMOTING_CODES` is asserted to exclude `STORE_UNVERIFIABLE`. Exit 0/1/2 need live stores and are recorded as untestable offline. |
| G11 | Seed provenance scripts were undocumented and filed under `.scratch/` | Moved to [tools/seed/](tools/seed) with [tools/seed/README.md](tools/seed/README.md); `gen_seed.py` verified to reproduce `data/` byte-for-byte after the move; `.scratch/` is now wholly gitignored and holds nothing tracked. |
| G12 | `package.json#files` published ODbL data without `LICENSE-DATA` | The allow-list now ships `LICENSE-DATA`, plus `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` — every file the published README links to. |
| G13 | `fetch/discover.py` died with a raw `KeyError`/`ValueError` traceback on `--store <unknown>` and `--workers 0` | Validated before any network work; usage errors exit 2 with a readable message. `tests/python-cli.test.mjs` asserts the message and the absence of `Traceback`. |
| G14 | `play_availability.py` documented exit 2 as "at least one check was unavailable or errored", but a confirmed 404 exits 0 | The docstring was backwards and the behaviour is the load-bearing one: [tools/lib/availability.mjs](tools/lib/availability.mjs) maps exit 2 to a warning, so a definite 404 must not land there. Corrected the docstring and pinned the mapping with an offline stub test. |
| G15 | No pull-request template, although CONTRIBUTING sends contributors to PRs | [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) mirrors the validator's rules as a checklist and asks for the evidence line per package. |
| G16 | No security policy | [SECURITY.md](SECURITY.md) names the real surface (untrusted catalog JSON, the loopback curator server, automated writes, supply chain) and the private reporting path, and separates data accuracy from security. |
| G17 | No `.editorconfig` | [.editorconfig](.editorconfig) pins LF, final newline and indentation across editors, because data files and bundles are diffed byte-for-byte in CI. |
| G18 | The two hand-runnable Python entry points had no offline test | `tests/python-cli.test.mjs` (7 tests): the availability exit-code contract under a stubbed store, its usage-error codes, the discovery planner's job list, that the default discovery store can actually search, and that every registered country has discovery queries. |
| G19 | Any value-taking flag would swallow the next flag as its value | `tools/lib/args.mjs#need` rejects an `undefined` or `--`-prefixed value with a `UsageError`; wired through `validate`/`build`/`recheck`/`curate`. The motivating bug was real: `build --out --quiet` wrote 20 artifacts into a working-tree directory literally named `--quiet`. `tests/cli.test.mjs` pins six flag pairs to exit 3 with a `needs a value` message and asserts no `--quiet` directory is left behind. |
| G20 | An unregistered `--country` was accepted and validated as clean | `tools/lib/args.mjs#needCountry` checks the code against `data/index.json#countries`, so `--country XX` now exits 3. A registered country that ships no folder (`SA`) still exits 0 — the registry, not the folder tree, is the contract. |
| G21 | `--max-messages` / `--max-demotions` accepted non-numeric values and silently disabled the cap | `tools/lib/args.mjs#needInt` uses `Number` (not `parseInt`, which reads `"12abc"` as `12`), requires an integer in range, and exits 3 otherwise. `abc` now fails loudly instead of validating an unbounded repo. |
| G22 | Usage errors disagreed on their exit code, and a malformed `--tag` was a build failure | Unified taxonomy: `validate` 0/1/2/**3**, `build` 0/1/**3**, `recheck` 0/1/2/**3**, `curate` 0/1/**3** (was 2). `usageGuard` prints usage + message to stderr and exits 3; a malformed release tag is a usage error, not a build failure. Documented in each CLI's docstring, `--help`, and the READMEs. |
| G23 | `curate --json` returned a weaker verdict than the human path | It returned before the repo-level `validateRepo` re-check and silently dropped `--check-stores`, so a `--json` consumer could see `ok:true` for a change that breaks the repo. Now one verdict shape — `{ok, changed, applied, file?, entries, errors, warnings, repo_errors, availability}` — with `repo_errors` scoped to the staged file. The consumer-less `stageable` key was removed. |
| G24 | `GET /api/catalog` read any JSON file on disk | `category` was interpolated into a path unchecked, so `category=../../package` returned the repository's `package.json` verbatim. Two layers now: the endpoint accepts only a bare lowercase identifier, and `tools/curate/lib.mjs#catalogPath` refuses any resolved path outside `data/` (which also makes the CLI write path fail closed). `tests/curate-server.test.mjs` pins both. |
| G25 | The curator server's own flags had the G19 bug and the old exit code | `--host` stored the next token whatever it was, `--port`/unknown-argument errors exited 2 while the rest of the CLI family exits 3, and the usage line advertised a `--open` flag that was never implemented. Now routed through `tools/lib/args.mjs` and `usageGuard(USAGE, 3, ...)`; the stale flag is gone from the usage text. |
| G26 | The curator could be bound to a non-loopback address | `--host 0.0.0.0` started normally, publishing an unauthenticated writer to `data/` to the whole network — while the docstring and `SECURITY.md` both promise a loopback-only server. Non-loopback hosts are now a usage error, enforced in both `parseArgs` and `start()`. |
| G27 | An oversized body broke the connection, and a missing catalog looked empty | The 64 KiB guard called `req.destroy()` before answering, so a client saw only a broken pipe; it now replies **413** and closes cleanly. `GET /api/catalog` returned 200 with `apps: []` for a country/category that has no file, indistinguishable from a real empty catalog; it is now **404**. |
| G29 | `validate.yml` saved a banner-prefixed "JSON" report | `npm run` prints its `> local-app-catalog@… validate` banner to **stdout**, so `npm run validate:stores -- --json --quiet > store-check.json` produced a file whose `JSON.parse` died with `SyntaxError: Unexpected token '>'`. Reproduced by hand (793 vs 711 bytes). Every CI step that reads JSON now uses `npm run --silent`, and the `Summarize` step answers a non-JSON file with an annotated warning instead of dying. |
| G30 | The nightly push could only ever create its branch, never update it | `git push --force-with-lease` without an expected value reads the local remote-tracking ref, and a fresh CI checkout has none for `nightly/recheck-<date>` — reproduced with a throwaway bare remote + clone (`! [rejected] … (stale info)`). Publishing logic is now [tools/recheck/open-pr.mjs](tools/recheck/open-pr.mjs), which interpolates the SHA `git ls-remote` reports into `--force-with-lease=<ref>:<sha>`, and `tests/recheck-pr.test.mjs` drives it against a real bare remote — including the same-day re-run from a brand-new clone. Commit `9f0e2a0`. |
| G31 | The "already-open PR" second run would have *discarded* the first night's demotions | Found by the G30 rig: `git checkout -B` starts the branch at the default branch's HEAD, so the forced push replaced the earlier commit instead of extending it. The tool now fetches the branch and `reset --soft FETCH_HEAD` before committing, so the push is a genuine fast-forward; `-is-ancestor` in the rig proves history is preserved. Commit `9f0e2a0`. |
| G32 | The release workflow reached the shell with an unvalidated tag | `run:` interpolated `${{ inputs.tag }}` verbatim. The tag is now resolved through an env var and must match `^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}$` before any step runs, and `gh release create` passes `--verify-tag`. |
| G33 | Two report parsers died on a broken file, one printing a reassurance | `validate.yml`'s `JSON.parse` had no guard; `recheck.yml`'s PR count fell back to `catch { "some" }`, so a broken report produced a PR titled "demote some entries" that a reviewer could not check against anything. Both reads now fail loudly (the summarizer as an annotated warning, the count as a hard `--report` error pinned by the rig). |
| G34 | The demotion PR re-probed the stores it was supposed to publish findings from | The inline workflow re-ran `recheck --apply`; a flaky store answer between probe and apply would make the PR's diff disagree with its own report. The PR now replays the recorded report (`recheck --apply --plan recheck.json`), which pins `--plan` as the mechanism: findings are re-validated against the demotion code set and resolved through the same `LOCAL_APP_CATALOG_DATA` override that decided what was checked, and `open-pr.mjs` further publishes only if `git add data` actually stages something. |
| G28 | `tools/curate/server.mjs` had no tests at all | [tests/curate-server.test.mjs](tests/curate-server.test.mjs) (8 tests) covering traversal refusal, the 404/200 split, 413, malformed JSON, that a rejected `/api/apply` leaves `data/` byte-identical, that a non-loopback bind throws, and the exit-3 usage contract with no stack trace. |
| D1 | Build was not reproducible (`generated_at` read the wall clock) | `tools/lib/bundle.mjs` + `tools/build/cli.mjs`; regression test in `tests/bundle.test.mjs`; commit `4043b63`. |
| D2 | `validate.yml` summary read non-existent keys (`counts.errors`) | Rewritten to `r.errors` / `r.warnings` / `r.store_inconclusive`. |
| D3 | Transient `.scratch` outputs were tracked | `.gitignore` + `git rm --cached`; commit `4043b63`. |

## Known limitations (not gaps to close)

- **Live store verification is impossible from this runner.** It sits behind a
  datacenter IP: APKPure returns 403, Myket 404s anonymous probes, Café Bazaar
  and RuStore reject anonymous API calls, and Play search occasionally 429s.
  `validate --check-stores` therefore exits 2 with `STORE_UNVERIFIABLE`
  warnings. That is a property of the runner, not of the data, and the design
  treats it as advisory by construction.
- **`recheck` exit 0/1/2 and `validate` exit 2 require network.** Their offline
  halves (usage errors, `--help`, the demotion code set) are tested; the
  network halves are not.
- **The three GitHub workflows have never been executed on a real runner.**
  Their YAML is parse-checked, their shell steps are read by hand, and the
  nightly publish logic — the part that had already regressed once — is now
  extracted into `tools/recheck/open-pr.mjs` and driven against a real bare
  remote by `tests/recheck-pr.test.mjs` with a recording `gh` stub. What
  remains unverified is everything that needs GitHub itself: runner execution,
  real `gh` auth, and Actions secrets.
- `.scratch/candidates.json` is regenerable via `fetch/discover.py --all`.
- **The npm package is not published.** `private: true` blocks it; the `files`
  allow-list is kept correct so that the first publish is not a licensing
  accident (see G12).
- **`package.json` has no `devDependencies`.** The test suite needs nothing
  beyond Node's built-in `node:test`, and `npm test` runs without an install.
