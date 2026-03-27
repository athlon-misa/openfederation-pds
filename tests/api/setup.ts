// Test environment setup — runs before all integration tests
//
// By default, tests use the same database as dev (from .env).
// To use a separate test database, set TEST_DB_NAME env var.
// The .env file is loaded by dotenv before this runs, so we only
// override values that MUST differ for the test environment.

process.env.NODE_ENV = 'test';

// Only override DB_NAME if an explicit test database is requested
if (process.env.TEST_DB_NAME) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
}

// Ensure secrets are set (in case .env is missing)
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-characters-long-for-testing';
process.env.KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET || 'test-key-encryption-secret-at-least-32-chars';
process.env.PLC_DIRECTORY_URL = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
