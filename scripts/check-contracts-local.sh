#!/usr/bin/env bash
# Run local contract tests with fresh replay persistence, not exported counterexamples.
# This never deploys contracts or broadcasts transactions.
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${FORGE_BIN:-}" ]]; then
  FORGE="$FORGE_BIN"
elif command -v forge >/dev/null 2>&1; then
  FORGE="$(command -v forge)"
else
  FORGE="${HOME}/.local/share/retempo/toolchains/v1.7.1/forge"
fi
if [[ ! -x "$FORGE" ]]; then
  printf '%s\n' 'Forge is unavailable. Install the version in .foundry-version or set FORGE_BIN.' >&2
  exit 1
fi

# Keep generated output outside source. Export RETEMPO_CHECK_DIR to retain a named run.
if [[ -n "${RETEMPO_CHECK_DIR:-}" ]]; then
  RUN_DIR="$RETEMPO_CHECK_DIR"
else
  RUN_DIR="$(mktemp -d "${TMPDIR:?TMPDIR must point to the local scratch directory}/retempo-contract-check.XXXXXX")"
fi
mkdir -p "$RUN_DIR"
# A unique child directory prevents accidentally replaying a previous named run.
REPLAY_DIR="$(mktemp -d "$RUN_DIR/replay.XXXXXX")"
export FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR="$REPLAY_DIR"
# Shrinking affects failure diagnostics only, not run/depth limits or assertions.
export FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=0
printf 'Local test output: %s\nFresh invariant replay directory: %s\n' "$RUN_DIR" "$REPLAY_DIR"
cd -- "$PROJECT_ROOT"
"$FORGE" test --out "$RUN_DIR/out" --cache-path "$RUN_DIR/cache" --fuzz-seed 0x1 "$@"
