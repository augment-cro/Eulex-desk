#!/usr/bin/env bash
# Gate: no literal palette utilities / hex / rgb colors in frontend/src
# (.tsx/.ts only — globals.css token hexes are legitimate; its legacy CSS
# blocks are retokened in the reskin plan's Phase 4 with task-level checks).
# Allowlist: vendored shadcn primitives, third-party brand colors, the
# no-CSS-bundle error page, plus any line tagged `literal-ok`.
# Usage: scripts/check-theme-tokens.sh [--count file...]
set -uo pipefail
cd "$(dirname "$0")/.."

ALLOW='frontend/src/app/components/shared/IntegrationIcon.tsx|frontend/src/app/global-error.tsx|frontend/src/components/ui/'
PALETTE='\b(text|bg|border|divide|ring|from|via|to|fill|stroke|outline|decoration|caret|accent)-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b'
EXTRA='\b(bg|text)-(white|black)\b'
HEX='#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\('
# Retired EULEX compat-alias classes (must route through semantic tokens).
# bg-surface([^-]|$) excludes the real token bg-surface-elevated; text-ink(-NN)?
# catches text-ink + its -60/-40/-12 variants.
ALIAS='\b(bg-paper|bg-ink|text-on-ink|bg-card-muted|border-divider)\b|\btext-ink(-(60|40|12))?\b|\bbg-surface([^-]|$)|\brounded-(xs|s|m|l)\b'

hits() {
  grep -rnE "$1" frontend/src --include='*.tsx' --include='*.ts' \
    | grep -vE "$ALLOW" | grep -v 'literal-ok'
}

if [ "${1:-}" = "--count" ]; then
  shift
  for f in "$@"; do
    c=$( (grep -nE "$PALETTE|$EXTRA|$HEX|$ALIAS" "$f" 2>/dev/null || true) | grep -vc 'literal-ok' )
    echo "$f: $c"
  done
  exit 0
fi

OUT=$( { hits "$PALETTE"; hits "$EXTRA"; hits "$HEX"; hits "$ALIAS"; } )
N=$(printf '%s' "$OUT" | grep -c . || true)
if [ "$N" -gt 0 ]; then
  printf '%s\n' "$OUT" | head -50
  echo "check-theme-tokens: FAIL — $N literal color usages (50 shown)"
  exit 1
fi
echo "check-theme-tokens: PASS"
