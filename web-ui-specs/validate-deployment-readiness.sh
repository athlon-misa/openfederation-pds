#!/bin/bash
# validate-deployment-readiness.sh
# Validates: 08-deployment.md
# Generated for: OpenFederation Web Management Interface

set -e

SPEC_FILE="08-deployment.md"
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

check_deployment_strategies() {
    local strategies=("Docker Compose" "Railway")
    for strategy in "${strategies[@]}"; do
        if ! grep -qi "$strategy" "$SPEC_FILE"; then
            echo -e "${RED}✗ FAIL:${NC} Missing deployment strategy: $strategy"
            ((ERRORS++))
        fi
    done
    [[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ PASS:${NC} Deployment strategies documented"
}

check_environment_variables() {
    if ! grep -q "Environment Variables" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Environment variables section missing"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Environment variables documented"
    fi
}

check_docker_compose() {
    if ! grep -q "docker-compose" "$SPEC_FILE"; then
        echo -e "${RED}✗ FAIL:${NC} Docker Compose configuration missing"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Docker Compose configuration documented"
    fi
}

check_security_checklist() {
    if ! grep -qi "security" "$SPEC_FILE"; then
        echo -e "${YELLOW}⚠ WARN:${NC} Security checklist not found"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Security considerations documented"
    fi
}

check_monitoring() {
    if ! grep -qi "monitoring\|logging" "$SPEC_FILE"; then
        echo -e "${YELLOW}⚠ WARN:${NC} Monitoring/logging not documented"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Monitoring/logging documented"
    fi
}

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_deployment_strategies
check_environment_variables
check_docker_compose
check_security_checklist
check_monitoring

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "Errors: ${RED}$ERRORS${NC} | Warnings: ${YELLOW}$WARNINGS${NC}"
[[ $ERRORS -eq 0 ]] && echo -e "${GREEN}✓ VALIDATION PASSED${NC}" && exit 0 || { echo -e "${RED}✗ FAILED${NC}"; exit 1; }
