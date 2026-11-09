#!/usr/bin/env bash
# Verify a KnowMan CLI / MCP install end to end, without calling the KnowMan API.
#
#   scripts/verify-install.sh [mcp|cli|all] [--from-npm]
#
#   (default)    check the built bundle in this checkout (run "bun run build" first)
#   --from-npm   check what "npx -y @knowman/mcp" installs for a real user
#
# One package ships both surfaces (bins: knowman-mcp, knowman), so one script verifies both.
# Exit 0 = everything checked passed. Nothing here prints a credential.
set -euo pipefail

target="all"
from_npm=0
for arg in "$@"; do
  case "$arg" in
    mcp | cli | all) target="$arg" ;;
    --from-npm) from_npm=1 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_dir="$(cd "$here/.." && pwd)"
failures=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

# --- prerequisites -----------------------------------------------------------------------
if ! command -v node > /dev/null 2>&1; then
  echo "FAIL  node is not installed (Node 22 or newer is required)" >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -ge 22 ]; then
  pass "node $(node -v) (>= 22)"
else
  fail "node $(node -v) is too old; Node 22 or newer is required"
fi

if [ "$from_npm" -eq 1 ]; then
  command -v npx > /dev/null 2>&1 || { echo "FAIL  npx not found" >&2; exit 1; }
  mcp_cmd=(npx -y @knowman/mcp)
  cli_cmd=(npx -y -p @knowman/mcp knowman)
else
  for bundle in index.js cli.js; do
    if [ ! -f "$pkg_dir/dist/$bundle" ]; then
      echo "FAIL  dist/$bundle is missing; run \"bun run build\" in packages/mcp first" >&2
      exit 1
    fi
  done
  mcp_cmd=(node "$pkg_dir/dist/index.js")
  cli_cmd=(node "$pkg_dir/dist/cli.js")
fi

# --- credential source -------------------------------------------------------------------
# Ask the CLI (the one place that knows the lookup order and the auth file path) whether a
# credential is already available, so the MCP probe uses the real one instead of a placeholder.
status_out=""
cred_source=""
if status_out="$("${cli_cmd[@]}" status --format json 2>&1)"; then
  cred_source="$(node -e 'try{const s=JSON.parse(process.argv[1]);process.stdout.write(s.signedIn?String(s.source):"")}catch{}' "$status_out")"
fi

# --- MCP server --------------------------------------------------------------------------
if [ "$target" = "mcp" ] || [ "$target" = "all" ]; then
  if out="$(KNOWMAN_PROBE_CRED_SOURCE="$cred_source" node "$here/verify-install-probe.mjs" "${mcp_cmd[@]}" 2>&1)"; then
    pass "mcp: $out"
  else
    fail "mcp: $out"
  fi
fi

# --- CLI ---------------------------------------------------------------------------------
if [ "$target" = "cli" ] || [ "$target" = "all" ]; then
  if version="$("${cli_cmd[@]}" --version 2>&1)"; then
    pass "cli: knowman $version"
  else
    fail "cli: --version failed: $version"
  fi

  if help_out="$("${cli_cmd[@]}" --help 2>&1)" && grep -q '^kb-search$' <<< "$help_out" && grep -q '^  login' <<< "$help_out"; then
    pass "cli: --help lists the registry commands and login"
  else
    fail "cli: --help is missing commands"
  fi

  if [ -n "$status_out" ] && node -e 'const s=JSON.parse(process.argv[1]); process.exit(typeof s.signedIn==="boolean"?0:1)' "$status_out"; then
    if grep -q '"signedIn":true' <<< "$status_out"; then
      pass "cli: signed in (shared with knowman-mcp)"
    else
      pass "cli: status works; not signed in yet (run: knowman login)"
    fi
  else
    fail "cli: status did not return JSON"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All checks passed."
