#!/bin/bash
# validate-business-logic.sh
# Validates: 05-business-logic.yaml
# Generated for: OpenFederation Web Management Interface

set -e

SPEC_FILE="05-business-logic.yaml"
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

check_valid_yaml() {
    if command -v yq &> /dev/null; then
        yq eval '.' "$SPEC_FILE" > /dev/null 2>&1 || { echo -e "${RED}✗ FAIL:${NC} Invalid YAML"; ((ERRORS++)); return 1; }
        echo -e "${GREEN}✓ PASS:${NC} Valid YAML structure"
    else
        echo -e "${YELLOW}⚠ WARN:${NC} yq not installed, skipping YAML validation"
        ((WARNINGS++))
    fi
}

check_workflows() {
    if command -v yq &> /dev/null; then
        local count=$(yq eval '.workflows | keys | length' "$SPEC_FILE")
        [[ $count -lt 2 ]] && echo -e "${RED}✗ FAIL:${NC} Expected at least 2 workflows" && ((ERRORS++)) || echo -e "${GREEN}✓ PASS:${NC} Found $count workflows"
    fi
}

check_validation_rules() {
    if command -v yq &> /dev/null; then
        local has_rules=$(yq eval '.validation_rules' "$SPEC_FILE")
        [[ "$has_rules" == "null" ]] && echo -e "${RED}✗ FAIL:${NC} Validation rules missing" && ((ERRORS++)) || echo -e "${GREEN}✓ PASS:${NC} Validation rules defined"
    fi
}

check_services() {
    if command -v yq &> /dev/null; then
        local count=$(yq eval '.services | keys | length' "$SPEC_FILE")
        [[ $count -lt 2 ]] && echo -e "${YELLOW}⚠ WARN:${NC} Expected at least 2 services" && ((WARNINGS++)) || echo -e "${GREEN}✓ PASS:${NC} Found $count services"
    fi
}

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_valid_yaml
check_workflows
check_validation_rules
check_services

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "Errors: ${RED}$ERRORS${NC} | Warnings: ${YELLOW}$WARNINGS${NC}"
[[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ VALIDATION PASSED${NC}" && exit 0 || { echo -e "${RED}✗ FAILED${NC}"; exit 1; }
