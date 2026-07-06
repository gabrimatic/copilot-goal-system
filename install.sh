#!/usr/bin/env bash
set -euo pipefail

script_source="${BASH_SOURCE[0]:-}"
if [[ -n "$script_source" ]]; then
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  if [[ -f "$script_dir/scripts/install.sh" ]]; then
    cd "$script_dir"
    exec ./scripts/install.sh "$@"
  fi
fi

# Bootstrap mode: this script has no sibling scripts/install.sh next to it,
# which happens when it runs from a pipe (curl -fsSL ... | bash) or as a
# standalone download. Fetch the repository and delegate to its installer.
if ! command -v curl >/dev/null 2>&1; then
  echo "install.sh: curl is required to install from a remote source. Install curl, then rerun." >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "install.sh: tar is required to install from a remote source. Install tar, then rerun." >&2
  exit 1
fi

source_url="${GOAL_SYSTEM_INSTALL_SOURCE_URL:-https://github.com/gabrimatic/copilot-goal-system/archive/refs/heads/main.tar.gz}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

archive_path="$tmp_dir/copilot-goal-system.tar.gz"
if ! curl -fsSL "$source_url" -o "$archive_path"; then
  echo "install.sh: failed to download $source_url" >&2
  exit 1
fi

if ! tar -xzf "$archive_path" -C "$tmp_dir"; then
  echo "install.sh: failed to extract the downloaded archive from $source_url" >&2
  exit 1
fi

extracted_dir=""
for entry in "$tmp_dir"/*/; do
  [[ -d "$entry" ]] || continue
  extracted_dir="${entry%/}"
  break
done

if [[ -z "$extracted_dir" || ! -f "$extracted_dir/scripts/install.sh" ]]; then
  echo "install.sh: downloaded archive from $source_url did not contain scripts/install.sh" >&2
  exit 1
fi

cd "$extracted_dir"
./scripts/install.sh "$@"
