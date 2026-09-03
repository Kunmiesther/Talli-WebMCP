import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import {
  type LedgerMutationPrepareResponse,
  createTalliService,
} from '../src/app/talli-service.js';
import { type LedgerEvent, createLedgerDocument } from '../src/domain/ledger.js';
import { nairaToMinorUnits } from '../src/domain/money.js';

async function createRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-proposals-'));
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

function customerEvent(input: {
  id: string;
  displayName: string;
  timestamp: string;
}): LedgerEvent {
  return {
    id: `${input.id}:created`,
    kind: 'customer.created',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.id,
    displayName: input.displayName,
    aliases: [],
  };
}

function obligationEvent(input: {
  id: string;
  customerId: string;
  amountMinor: number;
  timestamp: string;
}): LedgerEvent {
  return {
    id: `${input.id}:created`,
    kind: 'obligation.created',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.customerId,
    obligationId: input.id,
    originalAmountMinor: input.amountMinor,
    dueAt: null,
  };
}

async function seedLedger(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  events: LedgerEvent[],
) {
  const document = createLedgerDocument('demo');
  document.events = [...events];
  await runtime.store.seed(
    {
      document,
      state: {
        ledgerCurrency: 'NGN',
        preferredCurrency: 'NGN',
      },
    },
    'demo',
  );
}

function expectConfirmationRequired(
  response: LedgerMutationPrepareResponse,
): Extract<LedgerMutationPrepareResponse, { status: 'confirmation_required' }> {
  expect(response.status).toBe('confirmation_required');
  return response as Extract<LedgerMutationPrepareResponse, { status: 'confirmation_required' }>;
}

function expectClarificationRequired(
  response: LedgerMutationPrepareResponse,
): Extract<LedgerMutationPrepareResponse, { status: 'clarification_required' }> {
  expect(response.status).toBe('clarification_required');
  return response as Extract<LedgerMutationPrepareResponse, { status: 'clarification_required' }>;
}

function expectRejected(
  response: LedgerMutationPrepareResponse,
): Extract<LedgerMutationPrepareResponse, { status: 'rejected' }> {
  expect(response.status).toBe('rejected');
  return response as Extract<LedgerMutationPrepareResponse, { status: 'rejected' }>;
}

describe('ledger mutation proposals', () => {
  it('keeps old persisted session state readable', async () => {
    const runtime = await createRuntime();

    try {
      const { statePath, ledgerPath } = runtime.store.resolveSessionPaths('demo');
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify(
          {
            version: 1,
            sessionId: 'demo',
            userId: 'demo',
            ledgerId: 'demo',
            ledgerCurrency: 'NGN',
            preferredCurrency: 'NGN',
            createdAt: '2026-08-30T00:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z',
            timezone: 'Africa/Lagos',
            recentTurns: [],
            pendingClarification: null,
            demoSeededAt: null,
          },
          null,
          2,
        ),
        'utf8',
      );
      await writeFile(ledgerPath, '', 'utf8');

      const loaded = await runtime.store.load('demo');
      expect(loaded.state.ledgerMutationProposal).toBeNull();
      expect(loaded.document.events).toEqual([]);
    } finally {
      await runtime.cleanup();
    }
  });

  it('prepares a proposal without mutating the ledger snapshot', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, [
        customerEvent({
          id: 'customer-sarah',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        obligationEvent({
          id: 'obligation-sarah',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(50),
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const before = await runtime.service.getLedger('demo');
      const response = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-sarah' },
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );
      const after = await runtime.service.getLedger('demo');

      expect(response.status).toBe('confirmation_required');
      expect(before).toEqual(after);
      expect(await runtime.service.getPendingLedgerMutation('demo')).not.toBeNull();

      const linkedToken = await runtime.service.createTelegramLinkToken('demo');
      const consumed = await runtime.service.consumeTelegramLinkToken({
        token: linkedToken.token,
        telegramUserId: '999999',
      });
      expect(consumed).not.toBeNull();

      const current = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/proposals/current', {
          headers: {
            cookie: `talli_session=${consumed?.webSessionToken ?? ''}`,
          },
        }),
      );
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({
        status: 'pending',
        proposal: {
          proposalId: response.proposal.proposalId,
        },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it('returns clarification_required for ambiguous customers without storing a proposal', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, [
        customerEvent({
          id: 'customer-sarah-a',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        customerEvent({
          id: 'customer-sarah-b',
          displayName: 'Sarah',
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const response = expectClarificationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'name', name: 'Sarah', allowCreate: false },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );

      expect(response.status).toBe('clarification_required');
      expect(response.candidates).toHaveLength(2);
      expect(await runtime.service.getPendingLedgerMutation('demo')).toBeNull();
    } finally {
      await runtime.cleanup();
    }
  });

  it('rejects unknown customers and malformed API payloads', async () => {
    const runtime = await createRuntime();

    try {
      const rejected = expectRejected(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'missing-customer' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.reasonCode).toBe('UNKNOWN_CUSTOMER');

      const badFields = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/proposals/prepare', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            operation: 'CREATE_OBLIGATION',
            customer: { kind: 'new', name: 'Bisi', aliases: [] },
            amount: { value: 20, currency: 'NGN' },
            sessionId: 'should-not-be-accepted',
          }),
        }),
      );

      expect(badFields.status).toBe(400);
      expect(await badFields.json()).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });

      const malformedMoney = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/proposals/prepare', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            operation: 'CREATE_OBLIGATION',
            customer: { kind: 'new', name: 'Bisi', aliases: [] },
            amount: { value: -1, currency: 'NGN' },
          }),
        }),
      );

      expect(malformedMoney.status).toBe(400);
      expect(await malformedMoney.json()).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });

      const badConfirm = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/proposals/confirm', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            proposalId: '123e4567-e89b-12d3-a456-426614174000',
            sessionId: 'should-not-be-accepted',
            status: 'confirmed',
          }),
        }),
      );

      expect(badConfirm.status).toBe(400);
      expect(await badConfirm.json()).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });

      const badCancel = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/proposals/cancel', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            proposalId: '123e4567-e89b-12d3-a456-426614174000',
            sessionId: 'should-not-be-accepted',
          }),
        }),
      );

      expect(badCancel.status).toBe(400);
      expect(await badCancel.json()).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it('supersedes a pending proposal with a new valid preparation', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, [
        customerEvent({
          id: 'customer-sarah',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        obligationEvent({
          id: 'obligation-sarah',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(60),
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const first = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-sarah' },
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );
      const firstProposalId = first.proposal.proposalId;

      const second = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'SETTLE_OBLIGATION',
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
        }),
      );
      expect(second.proposal.proposalId).not.toBe(firstProposalId);

      const current = await runtime.service.getPendingLedgerMutation('demo');
      expect(current?.proposalId).toBe(second.proposal.proposalId);

      const staleFirstConfirm = await runtime.service.confirmLedgerMutation(
        'demo',
        firstProposalId,
      );
      expect(staleFirstConfirm.status).toBe('rejected');
      expect(staleFirstConfirm.reasonCode).toBe('PROPOSAL_NOT_FOUND');
    } finally {
      await runtime.cleanup();
    }
  }, 10_000);

  it('confirms a stored action exactly once', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, []);

      const prepared = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Bisi', aliases: [] },
          amount: { value: 50, currency: 'NGN' },
        }),
      );

      const before = await runtime.service.getLedger('demo');
      const firstConfirm = await runtime.service.confirmLedgerMutation(
        'demo',
        prepared.proposal.proposalId,
      );
      expect(firstConfirm.status).toBe('confirmed');

      const afterFirstConfirm = await runtime.service.getLedger('demo');
      expect(afterFirstConfirm.customers).toHaveLength(1);
      expect(afterFirstConfirm.obligations).toHaveLength(1);
      expect(afterFirstConfirm).not.toEqual(before);

      const secondConfirm = await runtime.service.confirmLedgerMutation(
        'demo',
        prepared.proposal.proposalId,
      );
      expect(secondConfirm.status).toBe('already_confirmed');
      expect(await runtime.service.getLedger('demo')).toEqual(afterFirstConfirm);
    } finally {
      await runtime.cleanup();
    }
  });

  it('serializes concurrent confirmations and applies the action once', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, [
        customerEvent({
          id: 'customer-sarah',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        obligationEvent({
          id: 'obligation-sarah',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(40),
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const prepared = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-sarah' },
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );

      const [first, second] = await Promise.all([
        runtime.service.confirmLedgerMutation('demo', prepared.proposal.proposalId),
        runtime.service.confirmLedgerMutation('demo', prepared.proposal.proposalId),
      ]);

      expect([first.status, second.status].sort()).toEqual(['already_confirmed', 'confirmed']);

      const persisted = await runtime.store.load('demo');
      const matchingEvents = persisted.document.events.filter(
        (event) => event.turnId === prepared.proposal.proposalId,
      );
      expect(matchingEvents).toHaveLength(1);

      const ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(10));
      expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(30));
    } finally {
      await runtime.cleanup();
    }
  });

  it('retries confirmation safely after a partial persistence failure', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, [
        customerEvent({
          id: 'customer-sarah',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        obligationEvent({
          id: 'obligation-sarah',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(40),
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const prepared = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-sarah' },
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );

      const store = runtime.store as typeof runtime.store & {
        save: typeof runtime.store.save;
      };
      const originalSave = store.save.bind(store);
      store.save = async (session) => {
        await store.replaceLedger(session.ledgerPath, session.document);
        throw new Error('simulated confirmation failure');
      };

      await expect(
        runtime.service.confirmLedgerMutation('demo', prepared.proposal.proposalId),
      ).rejects.toThrow('simulated confirmation failure');

      const afterFailure = await runtime.store.load('demo');
      const matchingAfterFailure = afterFailure.document.events.filter(
        (event) => event.turnId === prepared.proposal.proposalId,
      );
      expect(matchingAfterFailure).toHaveLength(1);
      expect(afterFailure.state.ledgerMutationProposal?.status).toBe('pending');

      try {
        store.save = originalSave;

        const retry = await runtime.service.confirmLedgerMutation(
          'demo',
          prepared.proposal.proposalId,
        );
        expect(retry.status).toBe('already_confirmed');

        const afterRetry = await runtime.store.load('demo');
        const matchingAfterRetry = afterRetry.document.events.filter(
          (event) => event.turnId === prepared.proposal.proposalId,
        );
        expect(matchingAfterRetry).toHaveLength(1);
        expect(afterRetry.state.ledgerMutationProposal?.status).toBe('confirmed');

        const ledger = await runtime.service.getLedger('demo');
        expect(ledger.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(10));
        expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(30));
      } finally {
        store.save = originalSave;
      }
    } finally {
      await runtime.cleanup();
    }
  });

  it('cancels idempotently and blocks later confirmation', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, []);
      const initial = await runtime.service.getLedger('demo');

      const prepared = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Ada', aliases: [] },
          amount: { value: 20, currency: 'NGN' },
        }),
      );

      const firstCancel = await runtime.service.cancelLedgerMutation(
        'demo',
        prepared.proposal.proposalId,
      );
      expect(firstCancel.status).toBe('cancelled');

      const secondCancel = await runtime.service.cancelLedgerMutation(
        'demo',
        prepared.proposal.proposalId,
      );
      expect(secondCancel.status).toBe('already_cancelled');

      const confirmAfterCancel = await runtime.service.confirmLedgerMutation(
        'demo',
        prepared.proposal.proposalId,
      );
      expect(confirmAfterCancel.status).toBe('cancelled');
      expect(await runtime.service.getLedger('demo')).toEqual(initial);
    } finally {
      await runtime.cleanup();
    }
  });

  it('rejects confirmation after expiry and ledger changes', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, [
        customerEvent({
          id: 'customer-sarah',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        obligationEvent({
          id: 'obligation-sarah',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(40),
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const prepared = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-sarah' },
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );

      await runtime.store.updateState('demo', (state) => ({
        ...state,
        ledgerMutationProposal: state.ledgerMutationProposal
          ? {
              ...state.ledgerMutationProposal,
              expiresAt: '2026-01-01T00:00:00.000Z',
            }
          : null,
      }));

      const expired = await runtime.service.confirmLedgerMutation(
        'demo',
        prepared.proposal.proposalId,
      );
      expect(expired.status).toBe('expired');

      const preparedAgain = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-sarah' },
          obligation: { kind: 'id', obligationId: 'obligation-sarah' },
          amount: { value: 10, currency: 'NGN' },
          settleRemaining: false,
        }),
      );

      await runtime.service.setPreferredCurrency('demo', 'USD');
      const stale = await runtime.service.confirmLedgerMutation(
        'demo',
        preparedAgain.proposal.proposalId,
      );
      expect(stale.status).toBe('stale');
    } finally {
      await runtime.cleanup();
    }
  });

  it('rejects confirming a proposal from another session', async () => {
    const runtime = await createRuntime();

    try {
      await seedLedger(runtime, []);
      const prepared = expectConfirmationRequired(
        await runtime.service.prepareLedgerMutation('demo', {
          operation: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Grace', aliases: [] },
          amount: { value: 30, currency: 'NGN' },
        }),
      );

      const otherSession = await runtime.service.confirmLedgerMutation(
        'other-session',
        prepared.proposal.proposalId,
      );
      expect(otherSession.status).toBe('rejected');
      expect(otherSession.reasonCode).toBe('PROPOSAL_NOT_FOUND');
    } finally {
      await runtime.cleanup();
    }
  });

  it('uses the resolved session and rejects unexpected sessionId fields', async () => {
    const runtime = await createRuntime();

    try {
      const response = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/proposals/prepare?sessionId=demo', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            operation: 'CREATE_OBLIGATION',
            customer: { kind: 'new', name: 'Bisi', aliases: [] },
            amount: { value: 20, currency: 'NGN' },
            sessionId: 'malicious-session',
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 'error',
        errorCode: 'BAD_REQUEST',
      });
    } finally {
      await runtime.cleanup();
    }
  });
});
