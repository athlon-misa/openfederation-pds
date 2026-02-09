#!/usr/bin/env node
/**
 * Database Check Script
 * Verifies that the database is accessible and shows table status
 */

import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkDatabase() {
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    console.log('Connecting to database...');
    console.log(`  Host: ${process.env.DB_HOST}`);
    console.log(`  Port: ${process.env.DB_PORT}`);
    console.log(`  Database: ${process.env.DB_NAME}`);
    console.log(`  User: ${process.env.DB_USER}\n`);

    await client.connect();
    console.log('✓ Connected to database\n');

    // Check if tables exist
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    if (tablesResult.rows.length === 0) {
      console.log('⚠️  No tables found. Run "npm run db:init" to initialize the database.\n');
      process.exit(1);
    }

    console.log('Tables:');
    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get row count for each table
      const countResult = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      const count = countResult.rows[0].count;

      console.log(`  ✓ ${tableName.padEnd(20)} (${count} rows)`);
    }

    console.log('\n✅ Database is ready!');
  } catch (error) {
    console.error('\n❌ Database check failed:');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
    } else {
      console.error(error);
    }
    console.log('\nTroubleshooting:');
    console.log('  1. Ensure PostgreSQL is running');
    console.log('  2. Check your .env file for correct credentials');
    console.log('  3. Verify the database exists: createdb openfederation_pds');
    console.log('  4. Run "npm run db:init" to initialize the schema\n');
    process.exit(1);
  } finally {
    await client.end();
  }
}

checkDatabase();
