import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const runtimeUrl = new URL('../lib/runtime-env.ts', import.meta.url).href;
const dbUrl = new URL('../lib/db.ts', import.meta.url).href;
const handlerUrl = new URL('../api/handler.ts', import.meta.url).href;

function run(code: string, options: { vercel?: boolean; envFile?: string } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'harbor-env-'));
  const env = { ...process.env };
  delete env.VERCEL;
  delete env.HARBOR_ENV_TEST;
  delete env.DATABASE_URL;
  if (options.vercel) env.VERCEL = '1';
  if (options.envFile) writeFileSync(join(cwd, '.env'), options.envFile);
  try {
    return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
      cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('Vercel startup never reads a local .env and preserves injected configuration', () => {
  const result = run(`
    process.env.HARBOR_ENV_TEST = 'injected';
    process.loadEnvFile = () => { throw Error('LOCAL_ENV_MUST_NOT_BE_READ'); };
    await import(${JSON.stringify(runtimeUrl)});
    console.log(process.env.HARBOR_ENV_TEST);
  `, { vercel: true, envFile: 'HARBOR_ENV_TEST=local\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'injected');
  assert.equal(result.stderr, '');
});

test('local startup without an optional .env is silent', () => {
  const result = run(`await import(${JSON.stringify(runtimeUrl)});`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('the deployed HTTP entry point starts without .env and handles a request', () => {
  const result = run(`
    const {default: handler} = await import(${JSON.stringify(handlerUrl)});
    await handler({method:'OPTIONS',url:'/api/capabilities/health-ocr'}, {
      setHeader(){}, writeHead(status){console.log('HTTP_'+status);}, end(){},
    });
  `, { vercel: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HTTP_204/);
  assert.doesNotMatch(result.stderr, /ENOENT|No se pudo cargar/);
});

test('local .env is loaded before the database client is initialized', () => {
  const url = 'postgresql://qa:qa@localhost:5432/harbor_env_fixture';
  const result = run(`
    const {pool} = await import(${JSON.stringify(dbUrl)});
    console.log(pool.options.connectionString);
    await pool.end();
  `, { envFile: `DATABASE_URL=${url}\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), url);
});

test('unexpected local environment errors are not swallowed', () => {
  const result = run(`
    process.loadEnvFile = () => { throw Object.assign(Error('ENV_FILE_DENIED'), {code:'EACCES'}); };
    await import(${JSON.stringify(runtimeUrl)});
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENV_FILE_DENIED/);
});
