import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';
import { createLedgerDocument } from '../src/domain/ledger.js';

async function createRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-session-iso-'));
  const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
  const service = createTalliService({ store, interpreter: null });
  return {
    dataDir,
    store,
    service,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function cookiePair(setCookie: string | null): string {
  return setCookie?.split(';')[0] ?? '';
}

async function requestJson(
  service: Awaited<ReturnType<typeof createRuntime>>['service'],
  path: string,
  init: RequestInit = {},
) {
  const response = await handleTalliApiRequest(
    service,
    new Request(`http://localhost${path}`, init),
  );
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  return {
    response,
    body,
    setCookie: response.headers.get('set-cookie'),
  };
}

async function seedDefaultLedger(store: TalliSessionStore): Promise<void> {
  const document = createLedgerDocument('default');
  document.currency = 'USD';
  document.events = [
    {
      id: 'default-customer-created',
      kind: 'customer.created',
      timestamp: '2026-09-03T08:00:00.000Z',
      actor: 'system',
      customerId: 'default-customer',
      displayName: 'Default Customer',
      aliases: [],
    },
    {
      id: 'default-obligation-created',
      kind: 'obligation.created',
      timestamp: '2026-09-03T08:01:00.000Z',
      actor: 'system',
      customerId: 'default-customer',
      obligationId: 'default-obligation',
      originalAmountMinor: 6500,
      dueAt: null,
    },
  ];

  await store.seed(
    {
      document,
      state: {
        ledgerCurrency: 'USD',
        preferredCurrency: 'USD',
      },
    },
    'default',
  );
}

describe('anonymous browser session isolation', () => {
  it('bootstraps signed cookies, isolates browsers, rejects overrides, and preserves Telegram linkage', async () => {
    const runtime = await createRuntime();

    try {
      await seedDefaultLedger(runtime.store);

      const firstMe = await requestJson(runtime.service, '/api/me');
      expect(firstMe.response.status).toBe(200);
      expect(firstMe.body).toMatchObject({
        ok: true,
        connected: false,
      });
      expect(typeof (firstMe.body as { userId?: unknown }).userId).toBe('string');
      expect((firstMe.body as { userId: string }).userId).not.toBe('default');

      const firstSetCookie = firstMe.setCookie ?? '';
      const firstCookie = cookiePair(firstSetCookie);
      expect(firstCookie).toContain('talli_session=');
      expect(firstCookie).toContain('v1.');
      expect(firstSetCookie).toContain('HttpOnly');
      expect(firstSetCookie).toContain('SameSite=Lax');
      expect(firstSetCookie).not.toContain('Secure');

      const firstLedger = await requestJson(runtime.service, '/api/ledger', {
        headers: {
          cookie: firstCookie,
        },
      });
      expect(firstLedger.response.status).toBe(200);
      expect(firstLedger.body).toMatchObject({
        totals: {
          openOutstandingMinor: 0,
          settledOutstandingMinor: 0,
          totalPaidMinor: 0,
        },
      });
      expect((firstLedger.body as { customers?: unknown[] }).customers ?? []).toHaveLength(0);
      expect((firstLedger.body as { obligations?: unknown[] }).obligations ?? []).toHaveLength(0);

      const prepare = await requestJson(runtime.service, '/api/proposals/prepare', {
        method: 'POST',
        headers: {
          cookie: firstCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Bisi', aliases: [] },
          amount: { value: 120, currency: 'NGN' },
        }),
      });
      expect(prepare.response.status).toBe(200);
      expect(prepare.body).toMatchObject({
        status: 'confirmation_required',
      });

      const proposalId = (prepare.body as { proposal?: { proposalId?: string } }).proposal
        ?.proposalId;
      expect(typeof proposalId).toBe('string');

      const confirm = await requestJson(runtime.service, '/api/proposals/confirm', {
        method: 'POST',
        headers: {
          cookie: firstCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ proposalId }),
      });
      expect(confirm.response.status).toBe(200);
      expect(confirm.body).toMatchObject({
        status: 'confirmed',
      });

      const firstAfterConfirm = await requestJson(runtime.service, '/api/ledger', {
        headers: {
          cookie: firstCookie,
        },
      });
      expect(firstAfterConfirm.response.status).toBe(200);
      expect(
        (firstAfterConfirm.body as { totals: { openOutstandingMinor: number } }).totals
          .openOutstandingMinor,
      ).toBe(12_000);

      const secondMe = await requestJson(runtime.service, '/api/me');
      expect(secondMe.response.status).toBe(200);
      expect((secondMe.body as { userId: string }).userId).not.toBe(
        (firstMe.body as { userId: string }).userId,
      );
      const secondCookie = cookiePair(secondMe.setCookie ?? '');
      expect(secondCookie).toContain('talli_session=');
      expect(secondCookie).not.toBe(firstCookie);

      const secondLedger = await requestJson(runtime.service, '/api/ledger', {
        headers: {
          cookie: secondCookie,
        },
      });
      expect(secondLedger.response.status).toBe(200);
      expect(
        (secondLedger.body as { totals: { openOutstandingMinor: number } }).totals
          .openOutstandingMinor,
      ).toBe(0);

      const returningLedger = await requestJson(runtime.service, '/api/ledger', {
        headers: {
          cookie: firstCookie,
        },
      });
      expect(returningLedger.response.status).toBe(200);
      expect(
        (returningLedger.body as { totals: { openOutstandingMinor: number } }).totals
          .openOutstandingMinor,
      ).toBe(12_000);

      const tamperedCookie = `${firstCookie.slice(0, -1)}${firstCookie.endsWith('a') ? 'b' : 'a'}`;
      const tamperedMe = await requestJson(runtime.service, '/api/me', {
        headers: {
          cookie: tamperedCookie,
        },
      });
      expect(tamperedMe.response.status).toBe(200);
      expect((tamperedMe.body as { userId: string }).userId).not.toBe(
        (firstMe.body as { userId: string }).userId,
      );
      expect(cookiePair(tamperedMe.setCookie ?? '')).not.toBe(firstCookie);

      const queryOverride = await requestJson(runtime.service, '/api/ledger?sessionId=default', {
        headers: {
          cookie: firstCookie,
        },
      });
      expect(queryOverride.response.status).toBe(400);
      expect(queryOverride.body).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });

      const bodyOverride = await requestJson(runtime.service, '/api/message', {
        method: 'POST',
        headers: {
          cookie: firstCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Hello',
          sessionId: 'default',
          origin: 'web',
        }),
      });
      expect(bodyOverride.response.status).toBe(400);
      expect(bodyOverride.body).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });

      const linkToken = await requestJson(runtime.service, '/api/auth/telegram/link-token', {
        method: 'POST',
        headers: {
          cookie: firstCookie,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(linkToken.response.status).toBe(200);
      const linkTokenId = (linkToken.body as { linkToken?: string }).linkToken;
      expect(typeof linkTokenId).toBe('string');
      const storedToken = await runtime.service.getTelegramLinkToken(linkTokenId ?? '');
      expect(storedToken?.userId).toBe((firstMe.body as { userId: string }).userId);
    } finally {
      await runtime.cleanup();
    }
  });
});
