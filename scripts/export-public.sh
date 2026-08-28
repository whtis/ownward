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
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

read_package_version() {
  local file=$1 value
  [ -f "$file" ] || { echo "Release metadata is missing: $file" >&2; return 1; }
  if ! value=$(bun -e 'let parsed; try { parsed = JSON.parse(await Bun.file(Bun.argv[1]).text()); } catch { process.exit(2); } if (!parsed || typeof parsed.version !== "string") process.exit(3); console.log(parsed.version);' "$file" 2>/dev/null); then
    echo "Could not read package version from $file." >&2
    return 1
  fi
  if [[ ! "$value" =~ $SEMVER_RE ]]; then
    echo "Invalid package version in $file: ${value:-<empty>} (expected x.y.z)." >&2
    return 1
  fi
  printf '%s\n' "$value"
}

read_release_field() {
  local json=$1 field=$2 value
  if ! value=$(bun -e 'let parsed; try { parsed = JSON.parse(Bun.argv[1]); } catch { process.exit(2); } const value = parsed?.[Bun.argv[2]]; if (typeof value !== "string") process.exit(3); console.log(value);' "$json" "$field" 2>/dev/null); then
    echo "Release metadata checker returned invalid JSON ($field)." >&2
    return 1
  fi
  if [[ ! "$value" =~ $SEMVER_RE ]]; then
    echo "Release metadata checker returned invalid $field: $value." >&2
    return 1
  fi
  printf '%s\n' "$value"
}

read_kernel_version() {
  local root=$1 file lines count value
  file="$root/src/kernel/extensions/contracts.ts"
  [ -f "$file" ] || { echo "Release metadata is missing: $file" >&2; return 1; }
  lines=$(rg -n --no-heading '^[[:space:]]*export const KERNEL_VERSION[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*;' "$file" || true)
  count=$(printf '%s\n' "$lines" | sed '/^$/d' | wc -l | tr -d '[:space:]')
  if [ "$count" != 1 ]; then
    echo "Expected exactly one KERNEL_VERSION declaration in $file." >&2
    return 1
  fi
  value=$(printf '%s\n' "$lines" | sed -E 's/.*KERNEL_VERSION[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')
  if [[ ! "$value" =~ $SEMVER_RE ]]; then
    echo "Invalid KERNEL_VERSION in $file: ${value:-<empty>} (expected x.y.z)." >&2
    return 1
  fi
  printf '%s\n' "$value"
}

read_changelog_version() {
  local file=$1 header value
  [ -f "$file" ] || { echo "Release metadata is missing: $file" >&2; return 1; }
  header=$(awk '/^##[[:space:]]+/{ print; exit }' "$file")
  if [[ ! "$header" =~ ^##[[:space:]]+\[([0-9]+\.[0-9]+\.[0-9]+)\]([[:space:]]|$) ]]; then
    echo "CHANGELOG.md must start with a ## [x.y.z] release heading." >&2
    return 1
  fi
  value=${BASH_REMATCH[1]}
  if [[ ! "$value" =~ $SEMVER_RE ]]; then
    echo "Invalid first CHANGELOG release version: $value (expected x.y.z)." >&2
    return 1
  fi
  printf '%s\n' "$value"
}

version_component_gt() {
  local left=$1 right=$2
  if [ "${#left}" -ne "${#right}" ]; then
    [ "${#left}" -gt "${#right}" ]
  else
    [[ "$left" > "$right" ]]
  fi
}

version_gt() {
  local LC_ALL=C left=$1 right=$2 left_major left_minor left_patch right_major right_minor right_patch
  IFS=. read -r left_major left_minor left_patch <<< "$left"
  IFS=. read -r right_major right_minor right_patch <<< "$right"
  if [ "$left_major" != "$right_major" ]; then
    version_component_gt "$left_major" "$right_major"
    return
  fi
  if [ "$left_minor" != "$right_minor" ]; then
    version_component_gt "$left_minor" "$right_minor"
    return
  fi
  if [ "$left_patch" != "$right_patch" ]; then
    version_component_gt "$left_patch" "$right_patch"
    return
  fi
  return 1
}

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
ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/ownward-public-export.XXXXXX")
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
  if rg -q -i -F --hidden --no-ignore -- "$marker" "$STAGE"; then
    echo "Public export blocked by the private denylist." >&2
    exit 66
  fi
done < "$OWNWARD_PUBLIC_DENYLIST"

git -C "$STAGE" init --quiet
git -C "$STAGE" add -A --force
CANDIDATE_TREE=$(git -C "$STAGE" write-tree)
TARGET_TREE=$(git -C "$TARGET" rev-parse 'HEAD^{tree}')
RELEASE_CHECKER=""
if [ -f "$STAGE/scripts/release-metadata.ts" ]; then
  RELEASE_CHECKER="$STAGE/scripts/release-metadata.ts"
  if ! RELEASE_JSON=$(bun "$RELEASE_CHECKER" check "$STAGE" 2>&1); then
    echo "Release metadata check failed: $RELEASE_JSON" >&2
    exit 65
  fi
  SOURCE_VERSION=$(read_release_field "$RELEASE_JSON" version) || exit 65
  KERNEL_VERSION=$(read_release_field "$RELEASE_JSON" kernelVersion) || exit 65
  CHANGELOG_VERSION=$(read_release_field "$RELEASE_JSON" changelogVersion) || exit 65
else
  SOURCE_VERSION=$(read_package_version "$STAGE/package.json") || exit 65
  KERNEL_VERSION=$(read_kernel_version "$STAGE") || exit 65
  CHANGELOG_VERSION=$(read_changelog_version "$STAGE/CHANGELOG.md") || exit 65
fi
if [ "$SOURCE_VERSION" != "$KERNEL_VERSION" ] || [ "$SOURCE_VERSION" != "$CHANGELOG_VERSION" ]; then
  echo "Release metadata mismatch: package.json=$SOURCE_VERSION, KERNEL_VERSION=$KERNEL_VERSION, CHANGELOG=$CHANGELOG_VERSION." >&2
  exit 65
fi
TARGET_VERSION=$(read_package_version "$TARGET/package.json") || exit 65
if [ "$CANDIDATE_TREE" = "$TARGET_TREE" ]; then
  if [ "$SOURCE_VERSION" = "$TARGET_VERSION" ]; then
    echo "Public target already matches this candidate; nothing to publish."
    exit 0
  fi
  echo "Release metadata disagrees with an identical public tree: source=$SOURCE_VERSION, target=$TARGET_VERSION." >&2
  exit 65
fi
if [ "$SOURCE_VERSION" = "$TARGET_VERSION" ]; then
  echo "Version gate failed: source version $SOURCE_VERSION equals target version $TARGET_VERSION but the archive differs; bump the release version." >&2
  exit 65
fi
if ! version_gt "$SOURCE_VERSION" "$TARGET_VERSION"; then
  echo "Version gate failed: source version $SOURCE_VERSION must be greater than target version $TARGET_VERSION." >&2
  exit 65
fi
if [ -n "$RELEASE_CHECKER" ]; then
  if ! RELEASE_BASELINE_RESULT=$(bun "$RELEASE_CHECKER" check "$STAGE" "$TARGET" 2>&1); then
    echo "Version gate failed: $RELEASE_BASELINE_RESULT" >&2
    exit 65
  fi
fi
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
git -C "$PUBLISH_WORKTREE" add -A --force
if git -C "$PUBLISH_WORKTREE" diff --cached --quiet; then
  echo "Public target already matches this candidate; nothing to publish."
  exit 0
fi

if [ -z "$MESSAGE" ]; then MESSAGE="chore: sync public release"; fi
PUBLIC_AUTHOR_NAME=${OWNWARD_PUBLIC_AUTHOR_NAME:-"Ownward contributors"}
PUBLIC_AUTHOR_EMAIL=${OWNWARD_PUBLIC_AUTHOR_EMAIL:-"ownward@users.noreply.github.com"}
SOURCE_SHA=$(git -C "$SOURCE" rev-parse HEAD)
SOURCE_SHA_SHORT=$(git -C "$SOURCE" rev-parse --short HEAD)
SOURCE_SHA_LOWER=$(printf '%s' "$SOURCE_SHA" | tr '[:upper:]' '[:lower:]')
SOURCE_SHA_SHORT_LOWER=$(printf '%s' "$SOURCE_SHA_SHORT" | tr '[:upper:]' '[:lower:]')
for public_text in "$MESSAGE" "$PUBLIC_AUTHOR_NAME" "$PUBLIC_AUTHOR_EMAIL"; do
  PUBLIC_TEXT_LOWER=$(printf '%s' "$public_text" | tr '[:upper:]' '[:lower:]')
  if [[ "$PUBLIC_TEXT_LOWER" == *"$SOURCE_SHA_LOWER"* || "$PUBLIC_TEXT_LOWER" == *"$SOURCE_SHA_SHORT_LOWER"* ]]; then
    echo "Public commit metadata must not include a private source SHA." >&2
    exit 66
  fi
  while IFS= read -r marker || [ -n "$marker" ]; do
    case "$marker" in ""|'#'*) continue ;; esac
    if printf '%s' "$public_text" | rg -q -i -F -- "$marker"; then
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
