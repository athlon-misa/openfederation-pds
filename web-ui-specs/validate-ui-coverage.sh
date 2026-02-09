#!/bin/bash
# validate-ui-coverage.sh
# Validates: 06-ui-screens.md  
# Generated for: OpenFederation Web Management Interface

set -e

SPEC_FILE="06-ui-screens.md"
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

check_required_screens() {
    local required_screens=("login" "register" "communities" "create community" "admin")
    
    for screen in "${required_screens[@]}"; do
        if ! grep -qi "$screen" "$SPEC_FILE"; then
            echo -e "${RED}✗ FAIL:${NC} Missing screen documentation: $screen"
            ((ERRORS++))
        fi
    done
    
    [[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ PASS:${NC} All required screens documented"
}

check_user_flows() {
    if ! grep -q "User Flows" "$SPEC_FILE"; then
        echo -e "${YELLOW}⚠ WARN:${NC} User flows section not found"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} User flows documented"
    fi
}

check_authentication_screens() {
    if ! grep -q "Login Screen" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Login screen not documented"
        ((ERRORS++))
    fi
    
    if ! grep -q "Registration Screen" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Registration screen not documented"
        ((ERRORS++))
    fi
    
    [[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ PASS:${NC} Authentication screens documented"
}

check_community_screens() {
    if ! grep -q "Communities List" "$SPEC_FILE" && ! grep -q "Community List" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Communities list screen not documented"
        ((ERRORS++))
    fi
    
    if ! grep -q "Create Community" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Create community screen not documented"
        ((ERRORS++))
    fi
    
    [[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ PASS:${NC} Community screens documented"
}

check_admin_screens() {
    if ! grep -qi "admin" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Admin screens not documented"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Admin screens documented"
    fi
}

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_required_screens
check_user_flows
check_authentication_screens
check_community_screens
check_admin_screens

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "Errors: ${RED}$ERRORS${NC} | Warnings: ${YELLOW}$WARNINGS${NC}"
[[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ VALIDATION PASSED${NC}" && exit 0 || { echo -e "${RED}✗ FAILED${NC}"; exit 1; }
