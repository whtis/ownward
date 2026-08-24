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
   private documentation. Commit that reviewed candidate in the private repo.
3. Run the exporter from that clean candidate:

   ```bash
   # Stored outside both repositories; one private marker per line.
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
and runs `./verify.sh`. It first creates the public commit in a temporary Git
worktree; only after that succeeds does it fast-forward public `main`. It
exports with `git archive`, so private commits and Git objects are never copied.
The public repository receives one ordinary new commit on `main`.

Keep the denylist outside every Git repository and include any local account
names, hostnames, IP addresses, product codenames, customer identifiers, and
other organization-specific terms that must never be published. It is read at
release time and is deliberately not part of the public source tree.

To validate the candidate without changing the public checkout, use `--check`
(or omit the mode, as it is the default). Use `--apply` without `--push` when a
maintainer wants to inspect the new local public commit before running the
printed `git push` command. Public commits default to the neutral author
`Ownward contributors`; maintainers can set public-facing author values with
`OWNWARD_PUBLIC_AUTHOR_NAME` and `OWNWARD_PUBLIC_AUTHOR_EMAIL`. Their values,
as well as the commit message, are checked against the denylist.

## Bring public contributions back

Review and merge community pull requests in `whtis/ownward` first. Then
cherry-pick the selected public commits into the private development branch.
Never add the public remote to the production checkout as a shortcut, and never
force-push public `main` from the private repository.
