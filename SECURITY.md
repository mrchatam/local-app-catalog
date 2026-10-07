# Security policy

## What this repository is

LocalAppCatalog ships **data** (per-country app listings) and **offline tooling**
(a validator, a curation UI, a release bundler). There is no application server,
no user accounts, and no hosted service to attack. The realistic security surface
is therefore small but not empty:

- **Untrusted catalog input.** A contribution is an untrusted JSON document that
  `tools/validate` and `tools/curate` parse. A crafted entry must not be able to
  crash the validator, escape the `data/<cc>/<category>.json` path, or inject
  markup into the curator UI.
- **The curator's local server.** `tools/curate/server.mjs` binds to loopback and
  writes files under `data/`. Path traversal, a body-size bypass, or a
  request that writes outside `data/` is a security bug.
- **Automated writes.** The nightly `recheck` job opens a pull request. Anything
  that lets an external answer steer a merge into `main` — for example a store
  response being read as evidence instead of as a hint — is a security bug.
- **Supply chain.** `package.json` dependencies and the GitHub Actions in
  `.github/workflows/`.

## Reporting

Please report privately with GitHub's **Security → Report a vulnerability** tab
on this repository rather than in a public issue. Include the input or request
that triggers the problem and what you observed.

Expect an acknowledgement within a few days. This is a volunteer-maintained
open-source dataset; there is no bounty program and no formal SLA.

## Data accuracy is not a security issue

A wrong country or a stale listing is a **data** bug — open a normal *Report an
app* issue. Only report through this channel if something can crash a tool,
write outside `data/`, or influence a merge.
