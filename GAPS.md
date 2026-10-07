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
- `.scratch/candidates.json` is regenerable via `fetch/discover.py --all`.
