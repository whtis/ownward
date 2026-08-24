#!/usr/bin/env bash
# Export a reviewed public snapshot without ever pushing the private repository's
# Git objects or history. Run this only from a sanitized oss-sync worktree.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: OWNWARD_PUBLIC_DENYLIST=/secure/path/denylist.txt \\
  bash scripts/export-public.sh --target <public-repo-path> [--check | --apply [--push]] [--message <message>]

The source checkout must be a clean, sanitized oss-* worktree. The target must
be a clean checkout of whtis/ownward on main. The script archives source files,
runs the public verification gate, builds a commit in a temporary worktree, and
only then fast-forwards the public repository. The source Git history is never
copied.

--check is the default and does not change the public working tree or branch.
--apply creates a public commit;
--push additionally pushes it to origin/main. The denylist is a private,
one-marker-per-line file stored outside every Git repository.
EOF
}

TARGET=""
MESSAGE=""
APPLY=0
PUSH=0
while (($#)); do
  case "$1" in
    --target) TARGET=${2:-}; shift 2 ;;
    --message) MESSAGE=${2:-}; shift 2 ;;
    --check) APPLY=0; PUSH=0; shift ;;
    --apply) APPLY=1; shift ;;
    --push) PUSH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
[ -n "$TARGET" ] || { usage >&2; exit 64; }
[ "$PUSH" -eq 0 ] || [ "$APPLY" -eq 1 ] || { echo "--push requires --apply." >&2; exit 64; }
[ -n "${OWNWARD_PUBLIC_DENYLIST:-}" ] || { echo "Set OWNWARD_PUBLIC_DENYLIST to a private denylist file." >&2; exit 64; }
[ -f "$OWNWARD_PUBLIC_DENYLIST" ] || { echo "Public denylist is not a regular file." >&2; exit 64; }

SOURCE=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Run from a Git checkout." >&2; exit 64; }
TARGET=$(cd "$TARGET" && pwd -P) || { echo "Public target is not a directory: $TARGET" >&2; exit 64; }
[ "$SOURCE" != "$TARGET" ] || { echo "Source and public target must be different checkouts." >&2; exit 64; }
[ "${TARGET#"$SOURCE"/}" = "$TARGET" ] && [ "${SOURCE#"$TARGET"/}" = "$SOURCE" ] || {
  echo "Source and public target must not contain one another." >&2
  exit 64
}
git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Public target is not a Git checkout." >&2; exit 64; }
SOURCE_BRANCH=$(git -C "$SOURCE" branch --show-current)
case "$SOURCE_BRANCH" in oss-*) ;; *) echo "Source must be an oss-* review worktree, not a production branch." >&2; exit 65 ;; esac

if [ -n "$(git -C "$SOURCE" status --porcelain)" ]; then
  echo "Source checkout is dirty; commit the reviewed public candidate first." >&2
  exit 65
fi
if [ -n "$(git -C "$TARGET" status --porcelain)" ]; then
  echo "Public target is dirty; commit, stash, or discard its changes before syncing." >&2
  exit 65
fi
[ "$(git -C "$TARGET" branch --show-current)" = "main" ] || { echo "Public target must be on main." >&2; exit 65; }

REMOTE=$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)
case "$REMOTE" in
  git@github.com:whtis/ownward.git|https://github.com/whtis/ownward.git) ;;
  *) echo "Public target origin must be whtis/ownward (got: ${REMOTE:-none})." >&2; exit 65 ;;
esac
git -C "$TARGET" fetch --quiet origin main
[ "$(git -C "$TARGET" rev-parse HEAD)" = "$(git -C "$TARGET" rev-parse origin/main)" ] || {
  echo "Public target is not up to date with origin/main; pull it first." >&2
  exit 65
}

# Archives are only safe for this one-way release flow when the source has no
# submodules, symlinks, control-character paths, or tracked private-runtime paths.
if git -C "$SOURCE" cat-file -e HEAD:.gitmodules 2>/dev/null; then
  echo "Public candidate must not contain .gitmodules." >&2
  exit 66
fi
while IFS= read -r -d '' entry; do
  mode=${entry%%$'\t'*}
  path=${entry#*$'\t'}
  if LC_ALL=C printf '%s' "$path" | grep -q '[[:cntrl:]]'; then
    echo "Public candidate must not contain control-character paths." >&2
    exit 66
  fi
  case "$mode" in
    120000) echo "Public candidate must not contain symlinks: $path" >&2; exit 66 ;;
    160000) echo "Public candidate must not contain submodules: $path" >&2; exit 66 ;;
  esac
  case "$path" in config.json|config.json/*|.env|.env/*|data/*|prompts/owner.md) echo "Public candidate contains a private runtime path: $path" >&2; exit 66 ;; esac
done < <(git -C "$SOURCE" ls-tree -r -z --full-tree --format='%(objectmode)%x09%(path)' HEAD)

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/ownward-public-export.XXXXXX")
ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/ownward-public-export.XXXXXX.tar")
PUBLISH_WORKTREE=""
cleanup() {
  [ -z "$PUBLISH_WORKTREE" ] || git -C "$TARGET" worktree remove --force "$PUBLISH_WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
  rm -f "$ARCHIVE"
}
trap cleanup EXIT
git -C "$SOURCE" archive --format=tar HEAD > "$ARCHIVE"
tar -xf "$ARCHIVE" -C "$STAGE"

# Scan the archive, not the source checkout: archive is exactly what may leave
# this machine. --no-ignore includes dotfiles and lockfiles as well.
while IFS= read -r marker || [ -n "$marker" ]; do
  case "$marker" in ""|'#'*) continue ;; esac
  if rg -q -i -F --hidden --no-ignore "$marker" "$STAGE"; then
    echo "Public export blocked by the private denylist." >&2
    exit 66
  fi
done < "$OWNWARD_PUBLIC_DENYLIST"

git -C "$STAGE" init --quiet
echo "Running the verification gate against the exact archived public artifact…"
(cd "$STAGE" && ./verify.sh)

if [ "$APPLY" -eq 0 ]; then
  echo "Check passed. Re-run with --apply --push to update $TARGET."
  exit 0
fi

PUBLISH_WORKTREE=$(mktemp -d "${TMPDIR:-/tmp}/ownward-public-commit.XXXXXX")
rmdir "$PUBLISH_WORKTREE"
git -C "$TARGET" worktree add --quiet --detach "$PUBLISH_WORKTREE" HEAD
git -C "$PUBLISH_WORKTREE" rm -r --ignore-unmatch . >/dev/null
# Reuse the exact Git archive verified above. Never copy STAGE/.git into the
# publish worktree: its .git file points at the public repository's history.
tar -xf "$ARCHIVE" -C "$PUBLISH_WORKTREE"
git -C "$PUBLISH_WORKTREE" add -A
if git -C "$PUBLISH_WORKTREE" diff --cached --quiet; then
  echo "Public target already matches this candidate; nothing to publish."
  exit 0
fi

if [ -z "$MESSAGE" ]; then MESSAGE="chore: sync public release"; fi
PUBLIC_AUTHOR_NAME=${OWNWARD_PUBLIC_AUTHOR_NAME:-"Ownward contributors"}
PUBLIC_AUTHOR_EMAIL=${OWNWARD_PUBLIC_AUTHOR_EMAIL:-"ownward@users.noreply.github.com"}
SOURCE_SHA=$(git -C "$SOURCE" rev-parse HEAD)
SOURCE_SHA_SHORT=$(git -C "$SOURCE" rev-parse --short HEAD)
for public_text in "$MESSAGE" "$PUBLIC_AUTHOR_NAME" "$PUBLIC_AUTHOR_EMAIL"; do
  if [[ "$public_text" == *"$SOURCE_SHA"* || "$public_text" == *"$SOURCE_SHA_SHORT"* ]]; then
    echo "Public commit metadata must not include a private source SHA." >&2
    exit 66
  fi
  while IFS= read -r marker || [ -n "$marker" ]; do
    case "$marker" in ""|'#'*) continue ;; esac
    if printf '%s' "$public_text" | rg -q -i -F "$marker"; then
      echo "Public commit metadata is blocked by the private denylist." >&2
      exit 66
    fi
  done < "$OWNWARD_PUBLIC_DENYLIST"
done
git -C "$PUBLISH_WORKTREE" -c user.name="$PUBLIC_AUTHOR_NAME" -c user.email="$PUBLIC_AUTHOR_EMAIL" commit -m "$MESSAGE"
CANDIDATE=$(git -C "$PUBLISH_WORKTREE" rev-parse HEAD)
if [ "$PUSH" -eq 1 ]; then
  git -C "$PUBLISH_WORKTREE" push origin HEAD:main
  git -C "$TARGET" fetch --quiet origin main
  git -C "$TARGET" merge --ff-only origin/main
else
  git -C "$TARGET" merge --ff-only "$CANDIDATE"
  echo "Local public commit created but not pushed. Review it, then run: git -C '$TARGET' push origin main"
fi
echo "Public release complete: $(git -C "$TARGET" rev-parse --short HEAD)"
