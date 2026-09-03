import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseTalliSessionStore } from '../src/app/supabase-storage.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body ?? null;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

describe('Supabase link token storage', () => {
  it('ensures the parent talli_users row exists before creating a link token', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'talli-supabase-'));
    const requests: Array<{ pathname: string; search: string; method: string; body: unknown }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        pathname: url.pathname,
        search: url.search,
        method: init?.method ?? 'GET',
        body: parseBody(init?.body),
      });

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });

    try {
      const store = new SupabaseTalliSessionStore({
        supabaseUrl: 'https://example.supabase.co',
        supabaseServiceRoleKey: 'service-role-key',
        defaultSessionId: 'demo',
      });

      const token = await store.createTelegramLinkToken({ sessionId: 'web-user' });
      expect(token.userId).toBe('web-user');

      const userInsert = requests.find(
        (entry) => entry.pathname.endsWith('/talli_users') && entry.method === 'POST',
      );
      const linkTokenInsert = requests.find(
        (entry) => entry.pathname.endsWith('/link_tokens') && entry.method === 'POST',
      );
      expect(userInsert).toMatchObject({
        method: 'POST',
        search: '?on_conflict=id',
        body: [{ id: 'web-user', updated_at: expect.any(String) }],
      });
      expect(linkTokenInsert).toMatchObject({
        method: 'POST',
        body: [
          expect.objectContaining({
            user_id: 'web-user',
            token: expect.any(String),
          }),
        ],
      });
      expect(
        requests.findIndex(
          (entry) => entry.pathname.endsWith('/talli_users') && entry.method === 'POST',
        ),
      ).toBeLessThan(
        requests.findIndex(
          (entry) => entry.pathname.endsWith('/link_tokens') && entry.method === 'POST',
        ),
      );
    } finally {
      fetchSpy.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
