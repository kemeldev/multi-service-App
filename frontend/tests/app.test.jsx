import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../src/App';

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders without crashing when the APIs are unreachable', async () => {
    // Every fetch rejects, simulating both APIs being down.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));

    render(<App />);

    // The app must render something rather than throwing.
    expect(document.body.textContent.length).toBeGreaterThan(0);
  });

  it('renders when the APIs respond normally', async () => {
    // App.jsx calls /api/info and /api/db per service through the same global
    // fetch, so the mock has to return the right shape for each endpoint -
    // a single flat body (as in the generic example) makes the "database up"
    // branch read `db.recent.length` off `undefined` and throw.
    vi.stubGlobal(
      'fetch',
      vi.fn((url) => {
        const isDb = String(url).includes('/api/db');
        const body = isDb
          ? {
              db_status: 'up',
              db_time: new Date().toISOString(),
              db_version: 'PostgreSQL 16.0',
              row_count: 1,
              last_write_at: new Date().toISOString(),
              writes_ok: 1,
              writes_failed: 0,
              recent: [],
              error: null,
              probe: 'live',
            }
          : {
              service: 'test-service',
              stack: 'Test / Node 1.0',
              host: 'test-host',
              port: 8000,
              table: 'test_heartbeat',
              db_target: 'test@db:5432/testdb',
              heartbeat_seconds: 10,
              started_at: new Date().toISOString(),
              commit_sha: 'abc123',
              build_time: '2026-01-01T00:00:00Z',
            };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        });
      }),
    );

    render(<App />);

    // Wait for the initial poll to resolve and re-render with the "up" data -
    // this is what actually exercises the branch that reads db.recent, etc.
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/PostgreSQL 16/);
    });

    expect(document.body.textContent.length).toBeGreaterThan(0);
  });
});
