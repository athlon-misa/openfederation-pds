#!/bin/bash
# validate-test-coverage.sh
# Validates: 07-testing.md
# Generated for: OpenFederation Web Management Interface

set -e

SPEC_FILE="07-testing.md"
ERRORS=0
WARNINGS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_file_exists() {
    [[ ! -f "$SPEC_FILE" ]] && echo -e "${RED}✗ FAIL:${NC} $SPEC_FILE not found" && exit 1
    echo -e "${GREEN}✓ PASS:${NC} $SPEC_FILE exists"
}

check_test_categories() {
    local categories=("Authentication" "Community" "Admin")
    for cat in "${categories[@]}"; do
        if ! grep -qi "$cat" "$SPEC_FILE"; then
            echo -e "${RED}✗ FAIL:${NC} Missing test category: $cat"
            ((ERRORS++))
        fi
    done
    [[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ PASS:${NC} All test categories present"
}

check_test_stack() {
    if ! grep -q "Testing Stack" "$SPEC_FILE"; then
        echo -e "${YELLOW}⚠ WARN:${NC} Testing stack not documented"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Testing stack documented"
    fi
}

check_coverage_goals() {
    if ! grep -qi "coverage" "$SPEC_FILE"; then
        echo -e "${YELLOW}⚠ WARN:${NC} Coverage goals not documented"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Coverage goals documented"
    fi
}

check_fixtures() {
    if ! grep -q "fixture" "$SPEC_FILE" && ! grep -q "Fixture" "$SPEC_FILE"; then
        echo -e "${YELLOW}⚠ WARN:${NC} Test fixtures not documented"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Test fixtures documented"
    fi
}

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_test_categories
check_test_stack
check_coverage_goals
check_fixtures

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "Errors: ${RED}$ERRORS${NC} | Warnings: ${YELLOW}$WARNINGS${NC}"
[[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ VALIDATION PASSED${NC}" && exit 0 || { echo -e "${RED}✗ FAILED${NC}"; exit 1; }
