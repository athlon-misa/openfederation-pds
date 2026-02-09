#!/usr/bin/env node
/**
 * Query Records Script
 * Shows all records for a given DID
 */

import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function queryRecords() {
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await client.connect();

    // Get the most recent community
    const communityResult = await client.query(`
      SELECT did, handle, created_at
      FROM communities
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (communityResult.rows.length === 0) {
      console.log('No communities found');
      return;
    }

    const community = communityResult.rows[0];
    console.log('Most recent community:');
    console.log(`  DID: ${community.did}`);
    console.log(`  Handle: ${community.handle}`);
    console.log(`  Created: ${community.created_at}\n`);

    // Get all records for this community
    const recordsResult = await client.query(`
      SELECT collection, rkey, cid, record, created_at
      FROM records_index
      WHERE community_did = $1
      ORDER BY collection, rkey
    `, [community.did]);

    if (recordsResult.rows.length === 0) {
      console.log('⚠️  No records found for this community!');
      console.log('This indicates the records were not created during community creation.');
    } else {
      console.log(`Records for ${community.did}:`);
      recordsResult.rows.forEach(row => {
        console.log(`\n  Collection: ${row.collection}`);
        console.log(`  RKey: ${row.rkey}`);
        console.log(`  CID: ${row.cid}`);
        console.log(`  Record:`, JSON.parse(row.record));
      });
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

queryRecords();
