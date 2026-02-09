#!/bin/bash
# validate-all.sh
# Master validation orchestrator
# Generated for: OpenFederation Web Management Interface

set -e

# ═══════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════

VALIDATORS=(
    "validate-database.sh"
    "validate-api-contract.sh"
    "validate-security-baseline.sh"
    "validate-integration-setup.sh"
    "validate-business-logic.sh"
    "validate-ui-coverage.sh"
    "validate-test-coverage.sh"
    "validate-deployment-readiness.sh"
)

PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ═══════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ═══════════════════════════════════════════════════════════════

echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     MASTER VALIDATION: OpenFederation Web Interface      ║"
echo "║     Running all 8 validation scripts...                  ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

for validator in "${VALIDATORS[@]}"; do
    echo -e "\n${YELLOW}▶ Running: $validator${NC}"
    
    if bash "./$validator"; then
        echo -e "${GREEN}✓ $validator PASSED${NC}"
        ((PASSED++))
    else
        echo -e "${RED}✗ $validator FAILED${NC}"
        ((FAILED++))
    fi
done

# ═══════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}                    VALIDATION SUMMARY                      ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "  Passed: ${GREEN}$PASSED${NC} / ${BOLD}8${NC}"
echo -e "  Failed: ${RED}$FAILED${NC} / ${BOLD}8${NC}"
echo ""

if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║          ${BOLD}✓ ALL VALIDATIONS PASSED${NC}${GREEN}                         ║${NC}"
    echo -e "${GREEN}║                                                           ║${NC}"
    echo -e "${GREEN}║  All 8 phases validated successfully!                    ║${NC}"
    echo -e "${GREEN}║                                                           ║${NC}"
    echo -e "${GREEN}║  Next Steps:                                              ║${NC}"
    echo -e "${GREEN}║  1. Review generated specifications                       ║${NC}"
    echo -e "${GREEN}║  2. Begin implementation following roadmap                ║${NC}"
    echo -e "${GREEN}║  3. Use specs as development reference                    ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    exit 0
else
    echo -e "${RED}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║          ${BOLD}✗ VALIDATION FAILURES DETECTED${NC}${RED}                   ║${NC}"
    echo -e "${RED}║                                                           ║${NC}"
    echo -e "${RED}║  $FAILED validation script(s) failed.                          ║${NC}"
    echo -e "${RED}║  Please review the error messages above.                  ║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════════════════════════╝${NC}"
    exit 1
fi
