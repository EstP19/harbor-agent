const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('pg');
const migration = require('./migration.json');

function readSql(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n?/g, '\n');
}

async function probe(client) {
  const { rows: [state] } = await client.query(readSql(migration.probe));
  if (!state?.present) return 'absent';
  return state.valid ? 'applied' : 'partial';
}

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const sql = readSql(migration.file);
  if (createHash('sha256').update(sql).digest('hex') !== migration.sha256) {
    throw new Error('SQL_CHECKSUM_MISMATCH');
  }
  const body = sql.match(/^BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/i)?.[1];
  if (!body) throw new Error('SQL_TRANSACTION_REQUIRED');

  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '60s'; SET LOCAL statement_timeout = '300s'");
    // Match the database migrator locks so an administrative migration cannot race this one.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('harbor-schema-migrations'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('harbor-health-policy-migrations'))");
    const state = await probe(client);
    if (state === 'partial') throw new Error('PARTIAL_SCHEMA');
    if (state === 'absent') {
      // The reviewed SQL assumes harbor_db_owner only inside this transaction.
      await client.query(body);
      if (await probe(client) !== 'applied') throw new Error('POSTCONDITION_FAILED');
    }
    await client.query('COMMIT');
    console.log(`[migration ${migration.number}] ${state === 'applied' ? 'verified' : 'applied'}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

migrate().catch(error => {
  const code = error.code ?? error.message;
  const safe = /^(?:DATABASE_URL_REQUIRED|SQL_CHECKSUM_MISMATCH|SQL_TRANSACTION_REQUIRED|PARTIAL_SCHEMA|POSTCONDITION_FAILED|[A-Z0-9]{5}|ECONNREFUSED|ENOTFOUND)$/.test(code);
  console.error(`[migration ${migration.number}] failed: ${safe ? code : 'DATABASE_ERROR'}`);
  process.exitCode = 1;
});
