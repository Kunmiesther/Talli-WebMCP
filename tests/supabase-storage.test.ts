import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

function expectExactKeys(value: Record<string, unknown>, keys: string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

describe('Supabase link token storage', () => {
  it('uses genuine upserts and writes the canonical link token columns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'talli-supabase-'));
    const requests: Array<{
      pathname: string;
      search: string;
      method: string;
      prefer: string;
      body: unknown;
    }> = [];
    const tableState = {
      talliUsers: new Map<string, Record<string, unknown>>(),
      telegramLinks: new Map<string, Record<string, unknown>>(),
      linkTokens: new Map<string, Record<string, unknown>>(),
      webSessions: new Map<string, Record<string, unknown>>(),
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers ?? {});
      const body = parseBody(init?.body);
      requests.push({
        pathname: url.pathname,
        search: url.search,
        method,
        prefer: headers.get('Prefer') ?? '',
        body,
      });

      if (method === 'GET' && url.pathname.endsWith('/telegram_links')) {
        return new Response(JSON.stringify([...tableState.telegramLinks.values()]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'GET' && url.pathname.endsWith('/link_tokens')) {
        return new Response(JSON.stringify([...tableState.linkTokens.values()]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'GET' && url.pathname.endsWith('/web_sessions')) {
        return new Response(JSON.stringify([...tableState.webSessions.values()]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/talli_users')) {
        expect(url.search).toBe('?on_conflict=id');
        expect(headers.get('Prefer')).toContain('resolution=merge-duplicates');
        const rows = Array.isArray(body) ? body : [];
        for (const row of rows) {
          expect(row).toEqual({
            id: 'web-user',
            updated_at: expect.any(String),
          });
          const id = String((row as Record<string, unknown>).id);
          tableState.talliUsers.set(id, { ...tableState.talliUsers.get(id), ...row });
        }
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/telegram_links')) {
        expect(url.search).toBe('?on_conflict=telegram_user_id');
        expect(headers.get('Prefer')).toContain('resolution=merge-duplicates');
        const rows = Array.isArray(body) ? body : [];
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Expected telegram_links rows to be objects.');
          }
          expectExactKeys(row as Record<string, unknown>, [
            'linked_at',
            'telegram_user_id',
            'telegram_username',
            'user_id',
          ]);
          const telegramUserId = String((row as Record<string, unknown>).telegram_user_id);
          tableState.telegramLinks.set(telegramUserId, { ...row });
        }
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/link_tokens')) {
        expect(url.search).toBe('?on_conflict=token');
        expect(headers.get('Prefer')).toContain('resolution=merge-duplicates');
        const rows = Array.isArray(body) ? body : [];
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Expected link_tokens rows to be objects.');
          }
          expectExactKeys(row as Record<string, unknown>, [
            'consumed_at',
            'created_at',
            'expires_at',
            'telegram_user_id',
            'telegram_username',
            'token',
            'user_id',
            'web_session_token',
          ]);
          expect((row as Record<string, unknown>).created_at).toEqual(expect.any(String));
          const token = String((row as Record<string, unknown>).token);
          tableState.linkTokens.set(token, { ...row });
        }
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/web_sessions')) {
        expect(url.search).toBe('?on_conflict=token');
        expect(headers.get('Prefer')).toContain('resolution=merge-duplicates');
        const rows = Array.isArray(body) ? body : [];
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Expected web_sessions rows to be objects.');
          }
          expectExactKeys(row as Record<string, unknown>, [
            'created_at',
            'expires_at',
            'revoked_at',
            'token',
            'user_id',
          ]);
          const token = String((row as Record<string, unknown>).token);
          tableState.webSessions.set(token, { ...row });
        }
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/conversation_sessions')) {
        expect(url.search).toBe('?on_conflict=user_id');
        expect(headers.get('Prefer')).toContain('resolution=merge-duplicates');
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/user_preferences')) {
        expect(url.search).toBe('?on_conflict=user_id');
        expect(headers.get('Prefer')).toContain('resolution=merge-duplicates');
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected Supabase request: ${method} ${url.pathname}${url.search}`);
    });

    try {
      const store = new SupabaseTalliSessionStore({
        supabaseUrl: 'https://example.supabase.co',
        supabaseServiceRoleKey: 'service-role-key',
        defaultSessionId: 'demo',
      });

      const firstToken = await store.createTelegramLinkToken({ sessionId: 'web-user' });
      const secondToken = await store.createTelegramLinkToken({ sessionId: 'web-user' });

      expect(firstToken.userId).toBe('web-user');
      expect(secondToken.userId).toBe('web-user');
      expect(firstToken.token).not.toBe(secondToken.token);

      const userInsertRequests = requests.filter(
        (entry) => entry.pathname.endsWith('/talli_users') && entry.method === 'POST',
      );
      const linkTokenRequests = requests.filter(
        (entry) => entry.pathname.endsWith('/link_tokens') && entry.method === 'POST',
      );

      expect(userInsertRequests).toHaveLength(2);
      expect(linkTokenRequests).toHaveLength(2);
      expect(
        requests.findIndex(
          (entry) => entry.pathname.endsWith('/talli_users') && entry.method === 'POST',
        ),
      ).toBeLessThan(
        requests.findIndex(
          (entry) => entry.pathname.endsWith('/link_tokens') && entry.method === 'POST',
        ),
      );
      expect(userInsertRequests[0]?.prefer).toContain('resolution=merge-duplicates');
      expect(userInsertRequests[1]?.prefer).toContain('resolution=merge-duplicates');

      const storedTokenRow = tableState.linkTokens.get(firstToken.token);
      expect(storedTokenRow).toMatchObject({
        token: firstToken.token,
        user_id: 'web-user',
        created_at: firstToken.createdAt,
        expires_at: firstToken.expiresAt,
        consumed_at: null,
        telegram_user_id: null,
        telegram_username: null,
        web_session_token: null,
      });
    } finally {
      fetchSpy.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('includes the forward migration that adds link_tokens.created_at safely', async () => {
    const migration = await readFile(
      join(process.cwd(), 'supabase', 'migrations', '002_fix_supabase_storage_contract.sql'),
      'utf8',
    );

    expect(migration).toContain('alter table link_tokens');
    expect(migration).toContain('add column if not exists created_at timestamptz');
    expect(migration).toContain('update link_tokens');
    expect(migration).toContain('coalesce(created_at, now())');
    expect(migration).toContain('alter column created_at set default now()');
    expect(migration).toContain('alter column created_at set not null');
  });
});
