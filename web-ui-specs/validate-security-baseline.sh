#!/bin/bash
# validate-security-baseline.sh
# Validates: 03-authentication.json
# Generated for: OpenFederation Web Management Interface

set -e

# ═══════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════
SPEC_FILE="03-authentication.json"
ERRORS=0
WARNINGS=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ═══════════════════════════════════════════════════════════════
# VALIDATION FUNCTIONS
# ═══════════════════════════════════════════════════════════════

check_file_exists() {
    if [[ ! -f "$SPEC_FILE" ]]; then
        echo -e "${RED}✗ FAIL:${NC} $SPEC_FILE not found"
        exit 1
    fi
    echo -e "${GREEN}✓ PASS:${NC} $SPEC_FILE exists"
}

check_valid_json() {
    if ! jq empty "$SPEC_FILE" 2>/dev/null; then
        echo -e "${RED}✗ FAIL:${NC} $SPEC_FILE is not valid JSON"
        ((ERRORS++))
        return 1
    fi
    echo -e "${GREEN}✓ PASS:${NC} Valid JSON structure"
}

check_authentication_strategy() {
    local strategy=$(jq -r '.authentication_strategy.primary_method' "$SPEC_FILE")
    
    if [[ -z "$strategy" || "$strategy" == "null" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Authentication strategy not defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Authentication strategy: $strategy"
    fi
}

check_password_requirements() {
    local min_length=$(jq -r '.security_baseline.password_requirements.min_length' "$SPEC_FILE")
    
    if [[ $min_length -lt 8 ]]; then
        echo -e "${RED}✗ FAIL:${NC} Password min_length must be at least 8 (got: $min_length)"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Password min_length: $min_length characters"
    fi
}

check_password_hashing() {
    local algorithm=$(jq -r '.security_baseline.password_hashing.algorithm' "$SPEC_FILE")
    local work_factor=$(jq -r '.security_baseline.password_hashing.work_factor' "$SPEC_FILE")
    
    if [[ "$algorithm" != "bcrypt" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Password hashing must use bcrypt (got: $algorithm)"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Password hashing: bcrypt"
    fi
    
    if [[ $work_factor -lt 10 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Bcrypt work factor should be at least 10 (got: $work_factor)"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Bcrypt work factor: $work_factor"
    fi
}

check_session_tokens() {
    local access_ttl=$(jq -r '.security_baseline.session_tokens.access_token_ttl' "$SPEC_FILE")
    local refresh_ttl=$(jq -r '.security_baseline.session_tokens.refresh_token_ttl' "$SPEC_FILE")
    
    if [[ "$access_ttl" != "15 minutes" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Access token TTL should be 15 minutes (got: $access_ttl)"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Access token TTL: $access_ttl"
    fi
    
    if [[ -z "$refresh_ttl" || "$refresh_ttl" == "null" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Refresh token TTL not defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Refresh token TTL: $refresh_ttl"
    fi
}

check_rate_limiting() {
    local login_limit=$(jq -r '.security_baseline.rate_limiting.login_attempts' "$SPEC_FILE")
    
    if [[ -z "$login_limit" || "$login_limit" == "null" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Login rate limiting not defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Login rate limiting: $login_limit"
    fi
}

check_registration_flow() {
    local flow_count=$(jq '.user_registration.flows | length' "$SPEC_FILE")
    
    if [[ $flow_count -lt 1 ]]; then
        echo -e "${RED}✗ FAIL:${NC} No registration flows defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Found $flow_count registration flow(s)"
    fi
    
    # Check for admin approval flow
    local has_approval=$(jq -r '.user_registration.flows[0].flow_name' "$SPEC_FILE" | grep -i "approval")
    if [[ -z "$has_approval" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Admin approval flow not explicitly named"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Admin approval flow present"
    fi
}

check_login_flow() {
    local flow_count=$(jq '.login_flow.flows | length' "$SPEC_FILE")
    
    if [[ $flow_count -lt 1 ]]; then
        echo -e "${RED}✗ FAIL:${NC} No login flows defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Found $flow_count login flow(s)"
    fi
}

check_session_management() {
    local has_get=$(jq -e '.session_management.get_current_session' "$SPEC_FILE" > /dev/null 2>&1 && echo "yes" || echo "no")
    local has_refresh=$(jq -e '.session_management.refresh_session' "$SPEC_FILE" > /dev/null 2>&1 && echo "yes" || echo "no")
    
    if [[ "$has_get" == "no" ]]; then
        echo -e "${RED}✗ FAIL:${NC} get_current_session not defined"
        ((ERRORS++))
    fi
    
    if [[ "$has_refresh" == "no" ]]; then
        echo -e "${RED}✗ FAIL:${NC} refresh_session not defined"
        ((ERRORS++))
    fi
    
    if [[ "$has_get" == "yes" && "$has_refresh" == "yes" ]]; then
        echo -e "${GREEN}✓ PASS:${NC} Session management endpoints defined"
    fi
}

check_authorization_rbac() {
    local role_count=$(jq '.authorization.role_based_access_control.roles | length' "$SPEC_FILE")
    
    if [[ $role_count -lt 2 ]]; then
        echo -e "${RED}✗ FAIL:${NC} Expected at least 2 roles (admin, user), found: $role_count"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Found $role_count role(s)"
    fi
    
    # Check for admin role
    local has_admin=$(jq '.authorization.role_based_access_control.roles[] | select(.role == "admin")' "$SPEC_FILE")
    if [[ -z "$has_admin" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Admin role not defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Admin role defined"
    fi
    
    # Check for user role
    local has_user=$(jq '.authorization.role_based_access_control.roles[] | select(.role == "user")' "$SPEC_FILE")
    if [[ -z "$has_user" ]]; then
        echo -e "${RED}✗ FAIL:${NC} User role not defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} User role defined"
    fi
}

check_jwt_validation() {
    local check_count=$(jq '.security_features.jwt_validation.checks | length' "$SPEC_FILE")
    
    if [[ $check_count -lt 3 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} JWT validation should include at least 3 checks (got: $check_count)"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} JWT validation checks: $check_count"
    fi
}

check_error_handling() {
    local error_count=$(jq '.error_handling.authentication_errors | length' "$SPEC_FILE")
    
    if [[ $error_count -lt 4 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Should define at least 4 error types (got: $error_count)"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Authentication errors defined: $error_count"
    fi
    
    # Check for specific error codes
    local has_401=$(jq '.error_handling.authentication_errors[] | select(.http_status == 401)' "$SPEC_FILE")
    local has_403=$(jq '.error_handling.authentication_errors[] | select(.http_status == 403)' "$SPEC_FILE")
    
    if [[ -z "$has_401" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Missing 401 Unauthorized error definition"
        ((ERRORS++))
    fi
    
    if [[ -z "$has_403" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Missing 403 Forbidden error definition"
        ((ERRORS++))
    fi
    
    if [[ -n "$has_401" && -n "$has_403" ]]; then
        echo -e "${GREEN}✓ PASS:${NC} Standard HTTP error codes defined"
    fi
}

check_at_protocol_integration() {
    local jwt_access_payload=$(jq -e '.login_flow.flows[0].steps[2].jwt_access_token_payload' "$SPEC_FILE" > /dev/null 2>&1 && echo "yes" || echo "no")
    
    if [[ "$jwt_access_payload" == "no" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} JWT access token payload structure not documented"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} JWT token payload documented"
    fi
    
    # Check for AT Protocol specific fields
    local has_did=$(jq -r '.login_flow.flows[0].steps[2].jwt_access_token_payload.sub' "$SPEC_FILE" | grep -i "did")
    if [[ -z "$has_did" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} JWT should use DID as subject"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} JWT uses DID as subject"
    fi
}

check_security_considerations() {
    # Check registration flow security
    local reg_security_count=$(jq '.user_registration.flows[0].security_considerations | length' "$SPEC_FILE" 2>/dev/null || echo 0)
    
    if [[ $reg_security_count -lt 3 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Registration should document at least 3 security considerations"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Registration security considerations: $reg_security_count"
    fi
    
    # Check login flow security
    local login_security_count=$(jq '.login_flow.flows[0].security_considerations | length' "$SPEC_FILE" 2>/dev/null || echo 0)
    
    if [[ $login_security_count -lt 3 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Login should document at least 3 security considerations"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Login security considerations: $login_security_count"
    fi
}

check_client_implementation_guide() {
    local has_guide=$(jq -e '.client_implementation_guide' "$SPEC_FILE" > /dev/null 2>&1 && echo "yes" || echo "no")
    
    if [[ "$has_guide" == "no" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Client implementation guide not provided"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Client implementation guide included"
    fi
}

check_testing_checklist() {
    local has_checklist=$(jq -e '.testing_checklist' "$SPEC_FILE" > /dev/null 2>&1 && echo "yes" || echo "no")
    
    if [[ "$has_checklist" == "no" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Testing checklist not provided"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Testing checklist included"
        
        # Count test categories
        local categories=$(jq '.testing_checklist | keys | length' "$SPEC_FILE")
        echo -e "${GREEN}  ├─${NC} Test categories: $categories"
    fi
}

# ═══════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ═══════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_valid_json
check_authentication_strategy
check_password_requirements
check_password_hashing
check_session_tokens
check_rate_limiting
check_registration_flow
check_login_flow
check_session_management
check_authorization_rbac
check_jwt_validation
check_error_handling
check_at_protocol_integration
check_security_considerations
check_client_implementation_guide
check_testing_checklist

# ═══════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════"
echo "VALIDATION SUMMARY"
echo "═══════════════════════════════════════════════════════"
echo -e "Errors:   ${RED}$ERRORS${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [[ $ERRORS -eq 0 ]]; then
    echo -e "${GREEN}✓ VALIDATION PASSED${NC}"
    if [[ $WARNINGS -gt 0 ]]; then
        echo -e "${YELLOW}  (with $WARNINGS warnings)${NC}"
    fi
    exit 0
else
    echo -e "${RED}✗ VALIDATION FAILED: $ERRORS errors${NC}"
    exit 1
fi
