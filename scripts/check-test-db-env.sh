#!/usr/bin/env bash
# `pnpm verify` runs the DB suites only when KAIJU_TEST_DATABASE_URL is set. KOBE-748 renamed it
# from KOBE_TEST_DATABASE_URL: fail loudly when only the old name is set, so the DB suites are not
# skipped without a word.
set -euo pipefail
if [ -z "${KAIJU_TEST_DATABASE_URL:-}" ] && [ -n "${KOBE_TEST_DATABASE_URL:-}" ]; then
  echo "KOBE_TEST_DATABASE_URL was renamed: set KAIJU_TEST_DATABASE_URL (the DB suites would be skipped)" >&2
  exit 1
fi
