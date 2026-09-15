# Public release maintenance

Ownward's public repository is updated from a reviewed `oss-*` worktree. A
release is a source snapshot, so its semantic version and changelog are part
of the public contract.

## Version parity

The public repository carries the **same version as the internal repository**.
Do not open a separate public patch line: when a fix ships internally as
`x.y.z`, the public snapshot that carries it is `x.y.z` too. This keeps the two
histories comparable and removes the bookkeeping that a divergent public
version required.

## Release metadata

Keep these three values identical for every public release:

- `package.json` → `version`
- `src/kernel/extensions/contracts.ts` → `KERNEL_VERSION`
- the first `## [x.y.z]` entry in `CHANGELOG.md`

Validate a candidate before exporting it:

```bash
bun scripts/release-metadata.ts check /path/to/ownward-oss-sync /path/to/ownward-public
```

The optional second path is the current public checkout. It compares only its
package version, so the first release that introduces `CHANGELOG.md` can still
be checked. The candidate version must be strictly greater than the public
baseline. Use patch releases for compatible fixes and documentation, minor
releases for additive Kernel capabilities, and a major release only for a
breaking contract. Increment `KERNEL_API_VERSION` only when an existing
extension contract becomes incompatible.

## Desk lock contract

Desk locks to the **internal** repository, not to the public snapshot — the
public repository is a mirror and an Android release channel, not Desk's
dependency source. Update Desk's `ownward.lock.json` when Desk should pick up a
new Ownward build:

- `repository` is the internal slug the private Ownward repository;
- `commit` is the internal `master` commit Desk is built against;
- `version` must equal that checkout's `package.json` version.

The Desk packager enforces `commit` and `version` against the `OWNWARD_ROOT`
checkout it builds from; it does not read `repository`, so that field is
documentation for humans.

Keep Desk's `minKernelVersion` unchanged when it does not use a newly added
Kernel capability. Raise it when the Desk manifest starts depending on the new
release; a compatible Kernel release does not by itself require a Desk
manifest change. Desk's manifest version is independent and may remain the
same when only its lock target changes.

The export gate must run `release-metadata.ts check` against the exact archived
candidate and the public baseline before creating a public commit. Tag the
published commit as `vX.Y.Z` after review. Do not copy private Git history,
runtime data, credentials, local paths, or organization-specific text into the
public snapshot. The author credit in the mobile Settings footer (`Tis Wu`) and
the repository / homepage links are **not** organization-specific text: keep
them verbatim (see `docs/app-guidelines.md`). Fixes made directly in the public
checkout must be backported to the internal repository before the next export,
otherwise the export overwrites them (2026-09: the Pages release channel in
`OwnwardClient.kt` had drifted this way).
