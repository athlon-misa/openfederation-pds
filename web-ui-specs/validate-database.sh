#!/bin/bash
# validate-database.sh
# Validates: 01-entities.json
# Generated for: OpenFederation Web Management Interface

set -e

# ═══════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════
SPEC_FILE="01-entities.json"
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

check_required_top_level_fields() {
    local required_fields=("project_id" "project_name" "phase" "generated_at" "database_config" "core_entities" "migration_order")
    
    for field in "${required_fields[@]}"; do
        if ! jq -e ".$field" "$SPEC_FILE" > /dev/null 2>&1; then
            echo -e "${RED}✗ FAIL:${NC} Missing required field: $field"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All required top-level fields present"
    fi
}

check_database_config() {
    local engine=$(jq -r '.database_config.engine' "$SPEC_FILE")
    local version=$(jq -r '.database_config.version' "$SPEC_FILE")
    
    if [[ "$engine" != "PostgreSQL" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Database engine must be PostgreSQL (got: $engine)"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Database engine is PostgreSQL"
    fi
    
    if [[ -z "$version" || "$version" == "null" ]]; then
        echo -e "${YELLOW}⚠ WARN:${NC} Database version not specified"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Database version: $version"
    fi
}

check_core_entities_exist() {
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    
    if [[ $entity_count -lt 1 ]]; then
        echo -e "${RED}✗ FAIL:${NC} No core entities defined"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Found $entity_count core entities"
    fi
}

check_required_entities() {
    local required_entities=("users" "communities" "invite_codes" "sessions")
    
    for entity in "${required_entities[@]}"; do
        local exists=$(jq --arg name "$entity" '.core_entities[] | select(.name == $name) | .name' "$SPEC_FILE")
        
        if [[ -z "$exists" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Required entity missing: $entity"
            ((ERRORS++))
        fi
    done
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All required entities present"
    fi
}

check_entity_structure() {
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    local valid=true
    
    for ((i=0; i<$entity_count; i++)); do
        local entity_name=$(jq -r ".core_entities[$i].name" "$SPEC_FILE")
        
        # Check required fields
        local required_fields=("id" "name" "type" "description" "attributes" "indexes" "relationships" "business_rules")
        for field in "${required_fields[@]}"; do
            if ! jq -e ".core_entities[$i].$field" "$SPEC_FILE" > /dev/null 2>&1; then
                echo -e "${RED}✗ FAIL:${NC} Entity '$entity_name' missing field: $field"
                ((ERRORS++))
                valid=false
            fi
        done
    done
    
    if $valid; then
        echo -e "${GREEN}✓ PASS:${NC} All entities have required fields"
    fi
}

check_standard_columns() {
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    local valid=true
    
    for ((i=0; i<$entity_count; i++)); do
        local entity_name=$(jq -r ".core_entities[$i].name" "$SPEC_FILE")
        local attributes=$(jq -r ".core_entities[$i].attributes[].name" "$SPEC_FILE")
        
        # Check for id, created_at, updated_at
        if ! echo "$attributes" | grep -q "^id$"; then
            echo -e "${RED}✗ FAIL:${NC} Entity '$entity_name' missing 'id' column"
            ((ERRORS++))
            valid=false
        fi
        
        if ! echo "$attributes" | grep -q "^created_at$"; then
            echo -e "${RED}✗ FAIL:${NC} Entity '$entity_name' missing 'created_at' column"
            ((ERRORS++))
            valid=false
        fi
        
        if ! echo "$attributes" | grep -q "^updated_at$"; then
            echo -e "${YELLOW}⚠ WARN:${NC} Entity '$entity_name' missing 'updated_at' column"
            ((WARNINGS++))
        fi
    done
    
    if $valid; then
        echo -e "${GREEN}✓ PASS:${NC} All entities have standard columns (id, created_at)"
    fi
}

check_uuid_primary_keys() {
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    local valid=true
    
    for ((i=0; i<$entity_count; i++)); do
        local entity_name=$(jq -r ".core_entities[$i].name" "$SPEC_FILE")
        local id_type=$(jq -r ".core_entities[$i].attributes[] | select(.name == \"id\") | .type" "$SPEC_FILE")
        
        if [[ "$id_type" != "UUID" ]]; then
            echo -e "${RED}✗ FAIL:${NC} Entity '$entity_name' id type is not UUID (got: $id_type)"
            ((ERRORS++))
            valid=false
        fi
    done
    
    if $valid; then
        echo -e "${GREEN}✓ PASS:${NC} All entities use UUID for primary keys"
    fi
}

check_foreign_key_indexes() {
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    local valid=true
    
    for ((i=0; i<$entity_count; i++)); do
        local entity_name=$(jq -r ".core_entities[$i].name" "$SPEC_FILE")
        
        # Get all foreign key columns
        local fk_columns=$(jq -r ".core_entities[$i].attributes[] | select(.constraints[]? | contains(\"FOREIGN_KEY\")) | .name" "$SPEC_FILE")
        
        # Check each FK has an index
        while IFS= read -r fk_col; do
            [[ -z "$fk_col" ]] && continue
            
            local has_index=$(jq --arg col "$fk_col" ".core_entities[$i].indexes[] | select(.columns[]? == \$col)" "$SPEC_FILE")
            
            if [[ -z "$has_index" ]]; then
                echo -e "${YELLOW}⚠ WARN:${NC} Entity '$entity_name' foreign key '$fk_col' has no index"
                ((WARNINGS++))
            fi
        done <<< "$fk_columns"
    done
    
    if [[ $WARNINGS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All foreign keys are indexed"
    fi
}

check_migration_order() {
    local migration_count=$(jq '.migration_order | length' "$SPEC_FILE")
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    
    if [[ $migration_count -ne $entity_count ]]; then
        echo -e "${RED}✗ FAIL:${NC} Migration order count ($migration_count) doesn't match entity count ($entity_count)"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} Migration order includes all entities"
    fi
    
    # Check for circular dependencies (basic check)
    # Users should come before communities (FK dependency)
    local users_pos=$(jq '.migration_order | index("users")' "$SPEC_FILE")
    local communities_pos=$(jq '.migration_order | index("communities")' "$SPEC_FILE")
    
    if [[ $communities_pos -lt $users_pos ]]; then
        echo -e "${RED}✗ FAIL:${NC} Circular dependency: communities appears before users"
        ((ERRORS++))
    else
        echo -e "${GREEN}✓ PASS:${NC} No obvious circular dependencies in migration order"
    fi
}

check_naming_conventions() {
    local entity_count=$(jq '.core_entities | length' "$SPEC_FILE")
    local valid=true
    
    for ((i=0; i<$entity_count; i++)); do
        local entity_name=$(jq -r ".core_entities[$i].name" "$SPEC_FILE")
        
        # Check snake_case (lowercase with underscores)
        if ! [[ "$entity_name" =~ ^[a-z][a-z0-9_]*$ ]]; then
            echo -e "${RED}✗ FAIL:${NC} Entity name '$entity_name' not in snake_case"
            ((ERRORS++))
            valid=false
        fi
        
        # Check column names
        local col_names=$(jq -r ".core_entities[$i].attributes[].name" "$SPEC_FILE")
        while IFS= read -r col_name; do
            if ! [[ "$col_name" =~ ^[a-z][a-z0-9_]*$ ]]; then
                echo -e "${RED}✗ FAIL:${NC} Column '$col_name' in '$entity_name' not in snake_case"
                ((ERRORS++))
                valid=false
            fi
        done <<< "$col_names"
    done
    
    if $valid; then
        echo -e "${GREEN}✓ PASS:${NC} All names follow snake_case convention"
    fi
}

check_phase_specific_features() {
    # Check Phase 1 specific requirements
    local has_users=$(jq '.core_entities[] | select(.name == "users")' "$SPEC_FILE")
    local has_communities=$(jq '.core_entities[] | select(.name == "communities")' "$SPEC_FILE")
    local has_invites=$(jq '.core_entities[] | select(.name == "invite_codes")' "$SPEC_FILE")
    
    if [[ -z "$has_users" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Phase 1 requirement: users entity missing"
        ((ERRORS++))
    fi
    
    if [[ -z "$has_communities" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Phase 1 requirement: communities entity missing"
        ((ERRORS++))
    fi
    
    if [[ -z "$has_invites" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Phase 1 requirement: invite_codes entity missing"
        ((ERRORS++))
    fi
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} All Phase 1 entities present"
    fi
}

check_at_protocol_integration() {
    # Verify AT Protocol specific fields
    local has_did=$(jq '.core_entities[] | select(.name == "users") | .attributes[] | select(.name == "did")' "$SPEC_FILE")
    local has_community_did=$(jq '.core_entities[] | select(.name == "communities") | .attributes[] | select(.name == "did")' "$SPEC_FILE")
    
    if [[ -z "$has_did" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Users entity missing 'did' field for AT Protocol"
        ((ERRORS++))
    fi
    
    if [[ -z "$has_community_did" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Communities entity missing 'did' field for AT Protocol"
        ((ERRORS++))
    fi
    
    # Check for did_method in communities
    local has_did_method=$(jq '.core_entities[] | select(.name == "communities") | .attributes[] | select(.name == "did_method")' "$SPEC_FILE")
    if [[ -z "$has_did_method" ]]; then
        echo -e "${RED}✗ FAIL:${NC} Communities entity missing 'did_method' field"
        ((ERRORS++))
    fi
    
    if [[ $ERRORS -eq 0 ]]; then
        echo -e "${GREEN}✓ PASS:${NC} AT Protocol integration fields present"
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
check_required_top_level_fields
check_database_config
check_core_entities_exist
check_required_entities
check_entity_structure
check_standard_columns
check_uuid_primary_keys
check_foreign_key_indexes
check_migration_order
check_naming_conventions
check_phase_specific_features
check_at_protocol_integration

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
