import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';

// Must be set BEFORE importing the app: no background heartbeat, and a
// database address that goes nowhere so nothing can accidentally connect.
process.env.HEARTBEAT_ENABLED = 'false';
process.env.DB_HOST = process.env.DB_HOST || '203.0.113.1'; // TEST-NET-3, guaranteed unroutable
process.env.DB_CONNECT_TIMEOUT = '30';
process.env.API_PREFIX = '';

// A dynamic import, not a static one: ES modules evaluate static `import`
// statements before any other top-level code in the file, so a static
// `import app from '../server.js'` would see the env vars above as unset.
// Awaiting a dynamic import() defers loading server.js until after they're set.
const { default: app } = await import('../server.js');

test('health returns 200', async () => {
  const res = await request(app).get('/health');
  assert.strictEqual(res.status, 200);
});

test('health does not touch the database', async () => {
  // DB_CONNECT_TIMEOUT is 30s and DB_HOST is unroutable. If /health touched
  // the database it would block for 30 seconds. It must answer instantly.
  const start = Date.now();
  const res = await request(app).get('/health');
  const elapsed = (Date.now() - start) / 1000;
  assert.strictEqual(res.status, 200);
  assert.ok(elapsed < 1.0, `/health took ${elapsed}s - it is touching the database`);
});

test('info has the expected shape', async () => {
  const res = await request(app).get('/api/info');
  assert.strictEqual(res.status, 200);
  for (const key of ['service', 'commit_sha', 'build_time']) {
    assert.ok(key in res.body, `missing key: ${key}`);
  }
});
