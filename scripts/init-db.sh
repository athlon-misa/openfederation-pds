#!/bin/bash

# Initialize the OpenFederation PDS database
# This script creates the database and applies the schema

set -e

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

DB_NAME=${DB_NAME:-openfederation_pds}
DB_USER=${DB_USER:-postgres}
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}

echo "Initializing OpenFederation PDS database..."
echo "Database: $DB_NAME"
echo "Host: $DB_HOST:$DB_PORT"
echo "User: $DB_USER"
echo ""

# Check if database exists
if psql -h $DB_HOST -p $DB_PORT -U $DB_USER -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
  echo "Database $DB_NAME already exists."
  read -p "Do you want to drop and recreate it? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Dropping database..."
    dropdb -h $DB_HOST -p $DB_PORT -U $DB_USER $DB_NAME
    echo "Creating database..."
    createdb -h $DB_HOST -p $DB_PORT -U $DB_USER $DB_NAME
  fi
else
  echo "Creating database..."
  createdb -h $DB_HOST -p $DB_PORT -U $DB_USER $DB_NAME
fi

echo "Applying schema..."
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f src/db/schema.sql

echo ""
echo "✅ Database initialized successfully!"
