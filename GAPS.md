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
| 4 | *(this commit)* | Value-taking flags swallowed the next flag (and `build --out --quiet` wrote a release into a directory literally named `--quiet`); an unregistered `--country` passed silently as clean; a non-numeric `--max-messages` silently disabled the cap; usage errors disagreed on their exit code; `curate --json` returned a weaker verdict than the human path. | G19–G23 |

## Open items

| # | Gap | Why it matters | Status |
|---|-----|----------------|--------|
| G10 | No trace evidence entities / reviews / seed export | The user required the trace graph; goals/tasks/decisions exist but findings and review records do not. | open |

## Done items

| # | Gap | Closed by |
|---|-----|-----------|
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
- **The three GitHub workflows have never been executed.** `gh` is unavailable
  here, so `.github/workflows/*.yml` are only YAML-parsed and their shell steps
  read by hand. Their exit-code branching is written to tolerate the usage-error
  code 3 explicitly (`validate.yml` fails on any status other than 0 or 2;
  `recheck.yml` on any status other than 0, 1 or 2) so a future CLI change
  cannot turn a usage error into a silent pass.
- `.scratch/candidates.json` is regenerable via `fetch/discover.py --all`.
- **The npm package is not published.** `private: true` blocks it; the `files`
  allow-list is kept correct so that the first publish is not a licensing
  accident (see G12).
- **`package.json` has no `devDependencies`.** The test suite needs nothing
  beyond Node's built-in `node:test`, and `npm test` runs without an install.
