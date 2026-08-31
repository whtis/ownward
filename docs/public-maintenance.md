# Maintaining the public repository

Ownward is developed in a private operational repository and released to the
separate public repository as reviewed file snapshots. This deliberately keeps
private commit history, production evidence, local paths, data, and credentials
out of the public Git object graph.

## Publish a reviewed update

1. Start from the private repository's current `master` in an isolated
   `oss-sync` worktree.
2. Bring across only changes suitable for the public source tree. Remove
   operational evidence, local paths, personal or customer identifiers, and
   private documentation. Prepare the release metadata before committing.
3. Commit that reviewed candidate in the private repo, then run the exporter
   from that clean candidate:

   ```bash
   export OWNWARD_PUBLIC_DENYLIST="$HOME/.config/ownward/public-denylist.txt"
   cd /path/to/ownward-oss-sync
   bash scripts/export-public.sh \
     --target /path/to/ownward-public \
     --apply --push \
     --message "feat: describe the public change"
   ```

The exporter refuses dirty source or target trees, requires an `oss-*` review
worktree, requires the public target's `origin` to be `whtis/ownward`, verifies
that `main` is current, scans the archived snapshot for known private markers,
checks release metadata and the version gate, and runs `./verify.sh`. It first
creates the public commit in a temporary Git worktree; only after that succeeds
does it fast-forward public `main`. It exports with `git archive`, so private
commits and Git objects are never copied.

## Release metadata and Desk lock

Every public content change is a release. Keep these three values identical in
the reviewed source candidate:

- `package.json` → `version`
- `src/kernel/extensions/contracts.ts` → `KERNEL_VERSION`
- the first release heading in `CHANGELOG.md` → `## [x.y.z]`

Validate a candidate before exporting it:

```bash
bun scripts/release-metadata.ts check /path/to/ownward-oss-sync /path/to/ownward-public
```

The exporter repeats this check against the exact archived candidate and public
baseline. A changed archive must have a strictly greater semver than the public
target. If the archive and target tree are identical and versions are equal,
the exporter reports that it already matches and exits successfully, so retries
remain idempotent. An equal-version archive with any content difference is
rejected.

Use patch releases for compatible fixes and documentation, minor releases for
additive Kernel capabilities, and a major release only for a breaking contract.
Increment `KERNEL_API_VERSION` only when an existing extension contract becomes
incompatible.

The public repository carries the same version as the private one. There is no
separate public patch line: a fix released privately as `x.y.z` is published as
`x.y.z` here too.

After a successful public snapshot push, create the matching `vX.Y.Z` tag in
`whtis/ownward`. Desk locks to the private repository rather than to this
mirror, so its `ownward.lock.json` records the private commit it is built
against and that checkout's `package.json` version; the Desk packager enforces
both against the checkout and does not read the repository field. Keep Desk's
`minKernelVersion` unchanged unless Desk actually uses an API introduced in the
new kernel; a compatible Kernel release does not require a Desk manifest change.

Keep the denylist outside every Git repository and include local account names,
hostnames, IP addresses, product codenames, customer identifiers, and other
organization-specific terms that must never be published.

## Bring public contributions back

Review and merge community pull requests in `whtis/ownward` first. Then
cherry-pick the selected public commits into the private development branch.
Never add the public remote to the production checkout as a shortcut, and never
force-push public `main` from the private repository.
