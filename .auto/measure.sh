#!/bin/bash
set -uo pipefail

# Count TypeScript errors
TS_OUTPUT=$(npx tsc --noEmit 2>&1 || true)
TS_ERRORS=$(echo "$TS_OUTPUT" | grep -c "^.*error TS" || echo "0")
echo "METRIC ts_errors=$TS_ERRORS"

# Count require() calls in ESM context
REQUIRE_IN_ESM=$(grep -rn "require(" extensions/ backends/ --include="*.ts" 2>/dev/null | grep -v "\.test\." | grep -v "import.meta" | grep -v "//.*require" | wc -l | tr -d ' ' || echo "0")
echo "METRIC require_in_esm=$REQUIRE_IN_ESM"

# Count explicit `any` types (excluding test files)
ANY_TYPES=$(grep -rn ": any" extensions/ backends/ --include="*.ts" 2>/dev/null | grep -v "\.test\." | wc -l | tr -d ' ' || echo "0")
echo "METRIC any_types=$ANY_TYPES"

# Count files with TS errors
FILES_WITH_ERRORS=$(echo "$TS_OUTPUT" | grep "^.*error TS" | sed 's/(.*//' | sort -u | wc -l | tr -d ' ' || echo "0")
echo "METRIC files_with_errors=$FILES_WITH_ERRORS"

# Run tests
TEST_OUTPUT=$(npm test 2>&1 || true)
TEST_FAILURES=$(echo "$TEST_OUTPUT" | grep -c "failed" || echo "0")
echo "METRIC test_failures=$TEST_FAILURES"
