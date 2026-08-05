#!/usr/bin/env bash
#
# Builds src.js by concatenating the modules in src/ inside one IIFE.
#
# src.js is the file consumers eval() straight off GitHub, so it stays
# committed at the repo root and the install URL never changes. It is a
# generated artifact: edit src/*.js and rebuild, never src.js itself.
#
#   ./build.sh           rebuild src.js from src/
#   ./build.sh --check    exit non-zero if the committed src.js is stale
#
# No dependencies beyond a POSIX shell, sed and diff - the same "no
# tooling required" posture the library itself has.

set -euo pipefail

cd "$(dirname "$0")"

# The module manifest, in build order. Kind modules first, then the cli
# layer that dispatches into them. Order is only cosmetic - every module
# is a list of hoisted function declarations sharing one closure - but an
# explicit list keeps the built file's reading order stable and makes
# "what is this library made of" a one-line answer.
MODULES="move.js model.js cli.js"

OUTPUT="src.js"

# Refuse to build if src/ holds a .js file the manifest doesn't mention.
# Without this, adding a module and forgetting to list it here produces a
# perfectly valid src.js that silently omits it.
for path in src/*.js; do
  file="${path##*/}"
  case " $MODULES " in
    *" $file "*) ;;
    *)
      echo "build.sh: src/$file is not listed in MODULES - add it to the manifest in build.sh." >&2
      exit 1
      ;;
  esac
done

# And refuse if the manifest names a file that isn't there.
for file in $MODULES; do
  if [ ! -f "src/$file" ]; then
    echo "build.sh: MODULES lists src/$file but that file does not exist." >&2
    exit 1
  fi
done

build() {
  local dest="$1"
  {
    echo "// GENERATED FILE - do not edit."
    echo "//"
    echo "// Built from src/ by ./build.sh. Edit the modules there and rebuild;"
    echo "// any change made here directly is lost on the next build."
    echo "//"
    echo "// Modules, in order: $MODULES"

    # One IIFE holds every module, so they share a single closure: each
    # module is just function declarations, and the library's whole public
    # surface is the object returned at the bottom.
    echo "var NotSoBigData = (function () {"

    for file in $MODULES; do
      echo "  // =================================================================="
      echo "  //   src/$file"
      echo "  // =================================================================="
      # Re-indent the module body into the IIFE. Matching "^." skips blank
      # lines, so they stay truly empty rather than becoming two spaces.
      sed 's/^./  &/' "src/$file"
      echo ""
    done

    # The wrapper lives here rather than in the modules because a bare
    # top-level "return" would make cli.js an invalid file on its own.
    echo "  return {"
    echo "    cli: cli"
    echo "  };"
    echo "})();"
  } > "$dest"
}

if [ "${1:-}" = "--check" ]; then
  expected="$(mktemp)"
  trap 'rm -f "$expected"' EXIT
  build "$expected"
  if ! diff -u "$OUTPUT" "$expected" > /dev/null 2>&1; then
    echo "build.sh: $OUTPUT is stale - it does not match src/. Run ./build.sh and commit the result." >&2
    diff -u "$OUTPUT" "$expected" >&2 || true
    exit 1
  fi
  echo "build.sh: $OUTPUT is up to date."
  exit 0
fi

if [ $# -gt 0 ]; then
  echo "build.sh: unknown argument '$1' (expected no arguments, or --check)." >&2
  exit 1
fi

build "$OUTPUT"
echo "build.sh: wrote $OUTPUT from src/ ($MODULES)."
