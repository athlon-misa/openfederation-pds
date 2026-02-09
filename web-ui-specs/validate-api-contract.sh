#!/bin/bash
# validate-api-contract.sh
# Validates: 02-api-specification.yaml
# Generated for: OpenFederation Web Management Interface

set -e

# ═══════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════
SPEC_FILE="02-api-specification.yaml"
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

check_valid_yaml() {
    # Check if yq is installed
    if ! command -v yq &> /dev/null; then
        echo -e "${YELLOW}⚠ WARN:${NC} yq not installed, skipping YAML validation"
        echo "  Install with: brew install yq (macOS) or snap install yq (Linux)"
        ((WARNINGS++))
        return
    fi
    
    if ! yq eval '.' "$SPEC_FILE" > /dev/null 2>&1; then
        echo -e "${RED}✗ FAIL:${NC} $SPEC_FILE is not valid YAML"
        ((ERRORS++))
        return 1
    fi
    echo -e "${GREEN}✓ PASS:${NC} Valid YAML structure"
}

check_openapi_version() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local version=$(yq eval '.openapi' "$SPEC_FILE")
    
    if [[ "$version" != "3.0.0" ]]; then
        echo -e "${RED}✗ FAIL:${NC} OpenAPI version must be 3.0.0 (got: $version)"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} OpenAPI version 3.0.0"
    fi
}

check_required_info_fields() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local required_fields=("title" "version" "description")
    
    for field in "${required_fields[@]}"; do
        local value=$(yq eval ".info.$field" "$SPEC_FILE")
        
        if [[ -z "$value" || "$value" == "null" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Missing info.$field"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All info fields present"
    fi
}

check_servers_defined() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local server_count=$(yq eval '.servers | length' "$SPEC_FILE")
    
    if [[ $server_count -lt 1 ]]; then
        echo -e "${RED}✗ FAIL:${NC} No servers defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Found $server_count server(s)"
    fi
}

check_authentication_endpoints() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local required_auth_endpoints=(
        "/xrpc/net.openfederation.account.register"
        "/xrpc/com.atproto.server.createSession"
        "/xrpc/com.atproto.server.getSession"
        "/xrpc/com.atproto.server.refreshSession"
    )
    
    for endpoint in "${required_auth_endpoints[@]}"; do
        local exists=$(yq eval ".paths[\"$endpoint\"]" "$SPEC_FILE")
        
        if [[ "$exists" == "null" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Required auth endpoint missing: $endpoint"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All authentication endpoints present"
    fi
}

check_community_endpoints() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local required_endpoints=(
        "/xrpc/net.openfederation.community.create"
        "/xrpc/com.atproto.repo.getRecord"
    )
    
    for endpoint in "${required_endpoints[@]}"; do
        local exists=$(yq eval ".paths[\"$endpoint\"]" "$SPEC_FILE")
        
        if [[ "$exists" == "null" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Required community endpoint missing: $endpoint"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All community endpoints present"
    fi
}

check_admin_endpoints() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local required_endpoints=(
        "/xrpc/net.openfederation.account.listPending"
        "/xrpc/net.openfederation.account.approve"
        "/xrpc/net.openfederation.account.reject"
    )
    
    for endpoint in "${required_endpoints[@]}"; do
        local exists=$(yq eval ".paths[\"$endpoint\"]" "$SPEC_FILE")
        
        if [[ "$exists" == "null" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Required admin endpoint missing: $endpoint"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All admin endpoints present"
    fi
}

check_security_definitions() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local bearer_auth=$(yq eval '.components.securitySchemes.bearerAuth' "$SPEC_FILE")
    local refresh_auth=$(yq eval '.components.securitySchemes.refreshAuth' "$SPEC_FILE")
    
    if [[ "$bearer_auth" == "null" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Missing security scheme: bearerAuth"
        ((ERRORS++))
    fi
    
    if [[ "$refresh_auth" == "null" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Missing security scheme: refreshAuth"
        ((ERRORS++))
    fi
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} Security schemes defined"
    fi
}

check_response_schemas() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local required_schemas=("Session" "Error" "InviteCode" "CommunityPLC" "CommunityWeb")
    
    for schema in "${required_schemas[@]}"; do
        local exists=$(yq eval ".components.schemas.$schema" "$SPEC_FILE")
        
        if [[ "$exists" == "null" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Required schema missing: $schema"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All required schemas defined"
    fi
}

check_error_responses() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local required_responses=("InvalidRequest" "Unauthorized" "Forbidden" "NotFound")
    
    for response in "${required_responses[@]}"; do
        local exists=$(yq eval ".components.responses.$response" "$SPEC_FILE")
        
        if [[ "$exists" == "null" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Required response missing: $response"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All error responses defined"
    fi
}

check_endpoint_http_methods() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    # Check that register is POST
    local register_method=$(yq eval '.paths["/xrpc/net.openfederation.account.register"] | keys | .[0]' "$SPEC_FILE")
    if [[ "$register_method" != "post" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Register endpoint must be POST (got: $register_method)"
        ((ERRORS++))
    fi
    
    # Check that getSession is GET
    local get_session_method=$(yq eval '.paths["/xrpc/com.atproto.server.getSession"] | keys | .[0]' "$SPEC_FILE")
    if [[ "$get_session_method" != "get" ]]; then
        echo -e "${RED}✗ FAIL:${NC} getSession endpoint must be GET (got: $get_session_method)"
        ((ERRORS++))
    fi
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} HTTP methods are correct"
    fi
}

check_at_protocol_compliance() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    # Check all paths start with /xrpc/
    local non_xrpc=$(yq eval '.paths | keys | .[]' "$SPEC_FILE" | grep -v "^/xrpc/" | wc -l)
    
    if [[ $non_xrpc -gt 0 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Found $non_xrpc endpoint(s) not following /xrpc/ convention"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} All endpoints follow AT Protocol /xrpc/ convention"
    fi
}

check_request_body_validation() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    # Check register endpoint has required fields
    local register_required=$(yq eval '.paths["/xrpc/net.openfederation.account.register"].post.requestBody.content."application/json".schema.required | length' "$SPEC_FILE")
    
    if [[ $register_required -lt 3 ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Register endpoint should require at least 3 fields (handle, email, password)"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Request body validation defined"
    fi
}

check_minimum_endpoint_count() {
    if ! command -v yq &> /dev/null; then
        return
    fi
    
    local endpoint_count=$(yq eval '.paths | keys | length' "$SPEC_FILE")
    
    if [[ $endpoint_count -lt 10 ]]; then
        echo -e "${RED}✗ FAIL:${NC} Expected at least 10 endpoints (Phase 1), found: $endpoint_count"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Found $endpoint_count endpoints (Phase 1 requires 10+)"
    fi
}

# ═══════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ═══════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════"
echo "Validating: $SPEC_FILE"
echo "═══════════════════════════════════════════════════════"

check_file_exists
check_valid_yaml
check_openapi_version
check_required_info_fields
check_servers_defined
check_authentication_endpoints
check_community_endpoints
check_admin_endpoints
check_security_definitions
check_response_schemas
check_error_responses
check_endpoint_http_methods
check_at_protocol_compliance
check_request_body_validation
check_minimum_endpoint_count

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
