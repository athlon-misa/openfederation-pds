#!/bin/bash
# validate-integration-setup.sh
# Validates: 04-integrations.json
# Generated for: OpenFederation Web Management Interface

set -e

SPEC_FILE="04-integrations.json"
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

check_valid_json() {
    jq empty "$SPEC_FILE" 2>/dev/null || { echo -e "${RED}✗ FAIL:${NC} Invalid JSON"; ((ERRORS++)); return 1; }
    echo -e "${GREEN}✓ PASS:${NC} Valid JSON structure"
}

check_core_integrations() {
    local count=$(jq '.core_integrations | length' "$SPEC_FILE")
    [[ $count -lt 1 ]] && echo -e "${RED}✗ FAIL:${NC} No core integrations defined" && ((ERRORS++)) || echo -e "${GREEN}✓ PASS:${NC} Found $count core integration(s)"
}

check_at_protocol() {
    local has_atproto=$(jq '.core_integrations[] | select(.name == "AT Protocol Integration")' "$SPEC_FILE")
    [[ -z "$has_atproto" ]] && echo -e "${RED}✗ FAIL:${NC} AT Protocol integration missing" && ((ERRORS++)) || echo -e "${GREEN}✓ PASS:${NC} AT Protocol integration defined"
}

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_valid_json
check_core_integrations
check_at_protocol

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "Errors: ${RED}$ERRORS${NC} | Warnings: ${YELLOW}$WARNINGS${NC}"
[[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ VALIDATION PASSED${NC}" && exit 0 || { echo -e "${RED}✗ FAILED${NC}"; exit 1; }
