import './runtime-env.ts';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
  signal?: AbortSignal,
): Promise<pg.QueryResult<T>> {
  if (!signal) return pool.query<T>(text, params);
  signal.throwIfAborted();
  const client = await pool.connect();
  let released = false;
  const abort = () => {
    if (!released) {
      released = true;
      client.release(true);
    }
  };
  if (signal.aborted) {
    abort();
    signal.throwIfAborted();
  }
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    signal.throwIfAborted();
    const result = await client.query<T>(text, params);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!released) client.release();
  }
}
