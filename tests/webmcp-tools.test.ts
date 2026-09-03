import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TalliWebMcpTool } from '../public/webmcp-tools.js';
import {
  createTalliWebMcpTools,
  registerTalliWebMcpTools,
  resetTalliWebMcpToolsForTests,
} from '../public/webmcp-tools.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertStrictObjectSchema(schema: unknown) {
  if (!isRecord(schema)) {
    return;
  }

  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
  }

  if (Array.isArray(schema.oneOf)) {
    for (const branch of schema.oneOf) {
      assertStrictObjectSchema(branch);
    }
  }

  if (isRecord(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      assertStrictObjectSchema(child);
    }
  }

  if ('items' in schema) {
    assertStrictObjectSchema(schema.items);
  }
}

function createLedgerFixture() {
  return {
    currency: 'NGN',
    totals: {
      openOutstandingMinor: 16000,
      settledOutstandingMinor: 0,
      totalPaidMinor: 4000,
    },
    customers: [
      {
        id: 'customer-sarah',
        displayName: 'Sarah',
        aliases: ['Sari'],
      },
      {
        id: 'customer-musa',
        displayName: 'Musa',
        aliases: [],
      },
    ],
    obligations: [
      {
        id: 'obligation-sarah-open',
        customerId: 'customer-sarah',
        customerName: 'Sarah',
        originalAmountMinor: 20000,
        totalPaidMinor: 4000,
        outstandingMinor: 16000,
        status: 'open',
        updatedAt: '2026-09-01T09:00:00.000Z',
        createdAt: '2026-09-01T08:00:00.000Z',
        dueAt: '2026-08-31T08:00:00.000Z',
      },
      {
        id: 'obligation-musa-open',
        customerId: 'customer-musa',
        customerName: 'Musa',
        originalAmountMinor: 12000,
        totalPaidMinor: 0,
        outstandingMinor: 12000,
        status: 'open',
        updatedAt: '2026-09-01T10:00:00.000Z',
        createdAt: '2026-09-01T10:00:00.000Z',
        dueAt: null,
      },
    ],
  };
}

function createAmbiguousLedgerFixture() {
  return {
    currency: 'NGN',
    totals: {
      openOutstandingMinor: 24000,
      settledOutstandingMinor: 0,
      totalPaidMinor: 0,
    },
    customers: [
      {
        id: 'customer-sarah-a',
        displayName: 'Sarah',
        aliases: [],
      },
      {
        id: 'customer-sarah-b',
        displayName: 'Sarah',
        aliases: ['Sara'],
      },
    ],
    obligations: [
      {
        id: 'obligation-sarah-a',
        customerId: 'customer-sarah-a',
        customerName: 'Sarah',
        originalAmountMinor: 10000,
        totalPaidMinor: 0,
        outstandingMinor: 10000,
        status: 'open',
        updatedAt: '2026-09-01T09:00:00.000Z',
        createdAt: '2026-09-01T08:00:00.000Z',
        dueAt: null,
      },
      {
        id: 'obligation-sarah-b',
        customerId: 'customer-sarah-b',
        customerName: 'Sarah',
        originalAmountMinor: 14000,
        totalPaidMinor: 0,
        outstandingMinor: 14000,
        status: 'open',
        updatedAt: '2026-09-01T10:00:00.000Z',
        createdAt: '2026-09-01T10:00:00.000Z',
        dueAt: null,
      },
    ],
  };
}

function createHistoryFixture() {
  return {
    customer: {
      id: 'customer-sarah',
      displayName: 'Sarah',
      aliases: ['Sari'],
    },
    obligations: [
      {
        id: 'obligation-1',
        customerId: 'customer-sarah',
        customerName: 'Sarah',
        originalAmountMinor: 12000,
        totalPaidMinor: 2000,
        outstandingMinor: 10000,
        status: 'open',
        updatedAt: '2026-09-01T11:00:00.000Z',
        createdAt: '2026-09-01T08:00:00.000Z',
        dueAt: '2026-08-31T08:00:00.000Z',
      },
      {
        id: 'obligation-2',
        customerId: 'customer-sarah',
        customerName: 'Sarah',
        originalAmountMinor: 6000,
        totalPaidMinor: 6000,
        outstandingMinor: 0,
        status: 'settled',
        updatedAt: '2026-09-01T12:00:00.000Z',
        createdAt: '2026-09-01T09:00:00.000Z',
        dueAt: null,
      },
    ],
    events: [
      {
        kind: 'customer.created',
        timestamp: '2026-09-01T08:00:00.000Z',
        displayName: 'Sarah',
        customerId: 'customer-sarah',
      },
      {
        kind: 'obligation.created',
        timestamp: '2026-09-01T09:00:00.000Z',
        customerId: 'customer-sarah',
        obligationId: 'obligation-1',
      },
      {
        kind: 'payment.recorded',
        timestamp: '2026-09-01T10:00:00.000Z',
        customerId: 'customer-sarah',
        obligationId: 'obligation-1',
        amountMinor: 2000,
      },
    ],
    recentTurns: [
      {
        turnId: 'turn-1',
        timestamp: '2026-09-01T08:00:00.000Z',
        message: 'Created a debt.',
        status: 'applied',
      },
      {
        turnId: 'turn-2',
        timestamp: '2026-09-01T10:00:00.000Z',
        message: 'Recorded a payment.',
        status: 'applied',
      },
    ],
  };
}

function parseResult(result: string) {
  expect(typeof result).toBe('string');
  return JSON.parse(result);
}

function requireTool(tool: TalliWebMcpTool | undefined): TalliWebMcpTool {
  if (!tool) {
    throw new Error('Missing registered tool');
  }

  return tool;
}

beforeEach(() => {
  resetTalliWebMcpToolsForTests();
});

describe('browser WebMCP registration', () => {
  it('is a no-op when document.modelContext is missing', async () => {
    await expect(registerTalliWebMcpTools({})).resolves.toBe(false);
  });

  it('registers exactly seven tools once and keeps schemas strict', async () => {
    const registered: Array<{ tool: TalliWebMcpTool; options: { signal?: AbortSignal } }> = [];
    const registerTool = vi.fn(async (tool, options) => {
      registered.push({ tool, options });
    });

    const document = {
      modelContext: {
        registerTool,
      },
    };

    await expect(
      registerTalliWebMcpTools({
        document,
        requestJson: vi.fn(),
        getSessionId: () => 'demo',
        onActivity: vi.fn(),
        onProposalOutcome: vi.fn(),
      }),
    ).resolves.toBe(true);

    await expect(
      registerTalliWebMcpTools({
        document,
        requestJson: vi.fn(),
        getSessionId: () => 'demo',
        onActivity: vi.fn(),
        onProposalOutcome: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(registerTool).toHaveBeenCalledTimes(7);
    expect(registered.map((entry) => entry.tool.name)).toEqual([
      'get_ledger_summary',
      'search_customers',
      'get_customer_balance',
      'get_customer_history',
      'list_overdue_debts',
      'prepare_ledger_mutation',
      'cancel_ledger_mutation',
    ]);
    expect(new Set(registered.map((entry) => entry.tool.name)).size).toBe(7);
    expect(registered.some((entry) => entry.tool.name === 'confirm_ledger_mutation')).toBe(false);

    for (const { tool, options } of registered) {
      expect(options).toMatchObject({ signal: expect.any(AbortSignal) });
      expect(tool.annotations.untrustedContentHint).toBe(true);
      assertStrictObjectSchema(tool.inputSchema);
    }

    const readTools = registered.slice(0, 5);
    for (const { tool } of readTools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }

    for (const { tool } of registered.slice(5)) {
      expect(tool.annotations.readOnlyHint).toBe(false);
    }
  });

  it('returns JSON strings for every tool and keeps results bounded', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const toolOutputs: Array<unknown> = [];
    const requestJson = vi.fn(async (path, options = {}) => {
      requests.push({
        path,
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (path.startsWith('/api/ledger')) {
        return createLedgerFixture();
      }

      if (path.startsWith('/api/customers/customer-sarah')) {
        return createHistoryFixture();
      }

      if (path.startsWith('/api/proposals/prepare')) {
        return {
          status: 'confirmation_required',
          proposal: {
            proposalId: 'proposal-1',
            operation: 'CREATE_OBLIGATION',
            summary: 'Create credit for Bisi for NGN 10.',
            status: 'pending',
            createdAt: '2026-09-02T10:00:00.000Z',
            expiresAt: '2026-09-02T10:10:00.000Z',
            confirmedAt: null,
            cancelledAt: null,
          },
          message: 'Review this proposal before confirming.',
        };
      }

      if (path.startsWith('/api/proposals/cancel')) {
        return {
          status: 'cancelled',
          reasonCode: null,
          message: 'Proposal cancelled.',
          proposal: null,
        };
      }

      throw new Error(`Unexpected request: ${path}`);
    });

    const tools = createTalliWebMcpTools({
      requestJson,
      getSessionId: () => 'demo',
      onActivity: vi.fn(),
      onProposalOutcome: (value: unknown) => toolOutputs.push(value),
    });
    const [
      summaryTool,
      searchTool,
      balanceTool,
      historyTool,
      overdueTool,
      prepareTool,
      cancelTool,
    ] = tools;

    const summary = parseResult(
      await requireTool(summaryTool).execute({}, { signal: new AbortController().signal }),
    );
    expect(summary).toMatchObject({
      status: 'ok',
      currency: 'NGN',
      totalOutstandingMinor: 16000,
      customerCount: 2,
      openObligationCount: 2,
      overdueCount: 1,
    });

    const search = parseResult(
      await requireTool(searchTool).execute(
        { query: 'a', limit: 1 },
        {
          signal: new AbortController().signal,
        },
      ),
    );
    expect(search).toMatchObject({
      status: 'ok',
      query: 'a',
      count: 2,
      truncated: true,
    });
    expect(search.results).toHaveLength(1);

    const balance = parseResult(
      await requireTool(balanceTool).execute(
        { customer: { kind: 'id', value: 'customer-sarah' } },
        { signal: new AbortController().signal },
      ),
    );
    expect(balance).toMatchObject({
      status: 'ok',
      currency: 'NGN',
      totalOutstandingMinor: 16000,
      truncated: false,
    });
    expect(balance.openObligations).toHaveLength(1);

    const history = parseResult(
      await requireTool(historyTool).execute(
        { customer: { kind: 'id', value: 'customer-sarah' }, limit: 1 },
        { signal: new AbortController().signal },
      ),
    );
    expect(history).toMatchObject({
      status: 'ok',
      truncated: true,
    });
    expect(history.history.openObligations).toHaveLength(1);
    expect(history.history.recentEvents).toHaveLength(1);
    expect(history.history.recentTurns).toHaveLength(1);

    const overdue = parseResult(
      await requireTool(overdueTool).execute(
        { limit: 1 },
        { signal: new AbortController().signal },
      ),
    );
    expect(overdue).toMatchObject({
      status: 'ok',
      currency: 'NGN',
      count: 1,
      truncated: false,
    });
    expect(overdue.results).toHaveLength(1);

    const prepare = parseResult(
      await requireTool(prepareTool).execute(
        {
          operation: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Bisi', aliases: [] },
          amount: { value: 10, currency: 'NGN' },
        },
        { signal: new AbortController().signal },
      ),
    );
    expect(prepare).toMatchObject({
      status: 'confirmation_required',
      proposalId: 'proposal-1',
      operation: 'CREATE_OBLIGATION',
      proposal: {
        proposalId: 'proposal-1',
        operation: 'CREATE_OBLIGATION',
      },
    });
    expect(requests.some((entry) => entry.path.includes('/api/proposals/confirm'))).toBe(false);

    const cancel = parseResult(
      await requireTool(cancelTool).execute(
        { proposalId: 'proposal-1' },
        { signal: new AbortController().signal },
      ),
    );
    expect(cancel).toMatchObject({
      status: 'cancelled',
      message: 'Proposal cancelled.',
    });

    expect(toolOutputs.length).toBeGreaterThan(0);
    expect(requests.some((entry) => entry.path.includes('/api/proposals/prepare'))).toBe(true);
    expect(requests.some((entry) => entry.path.includes('/api/proposals/cancel'))).toBe(true);
    expect(requests.every((entry) => !entry.path.includes('sessionId='))).toBe(true);
    for (const value of [summary, search, balance, history, overdue, prepare, cancel]) {
      expect(typeof JSON.stringify(value)).toBe('string');
    }
  });

  it('returns clarification_required for ambiguous customers without silently choosing one', async () => {
    const requestJson = vi.fn(async (path) => {
      if (path.startsWith('/api/ledger')) {
        return createAmbiguousLedgerFixture();
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const tools = createTalliWebMcpTools({
      requestJson,
      getSessionId: () => 'demo',
      onActivity: vi.fn(),
      onProposalOutcome: vi.fn(),
    });
    const [, , customerTool] = tools;

    const result = parseResult(
      await requireTool(customerTool).execute(
        { customer: { kind: 'name', value: 'Sarah' } },
        { signal: new AbortController().signal },
      ),
    );

    expect(result.status).toBe('clarification_required');
    expect(result.reasonCode).toBe('AMBIGUOUS_CUSTOMER');
    expect(result.candidates).toHaveLength(2);
  });

  it('prepares a proposal without calling confirmation', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const requestJson = vi.fn(async (path, options = {}) => {
      requests.push({
        path,
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (path.startsWith('/api/proposals/prepare')) {
        return {
          status: 'confirmation_required',
          proposal: {
            proposalId: 'proposal-2',
            operation: 'CREATE_OBLIGATION',
            summary: 'Create credit for Bisi for NGN 10.',
            status: 'pending',
            createdAt: '2026-09-02T10:00:00.000Z',
            expiresAt: '2026-09-02T10:10:00.000Z',
            confirmedAt: null,
            cancelledAt: null,
          },
          message: 'Review this proposal before confirming.',
        };
      }

      throw new Error(`Unexpected request: ${path}`);
    });

    const outcomes: Array<unknown> = [];
    const tools = createTalliWebMcpTools({
      requestJson,
      getSessionId: () => 'demo',
      onActivity: vi.fn(),
      onProposalOutcome: (value: unknown) => outcomes.push(value),
    });
    const [, , , , , prepareTool] = tools;

    const result = parseResult(
      await requireTool(prepareTool).execute(
        {
          operation: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Bisi', aliases: [] },
          amount: { value: 10, currency: 'NGN' },
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(result).toMatchObject({
      status: 'confirmation_required',
      proposalId: 'proposal-2',
      summary: 'Create credit for Bisi for NGN 10.',
      ledgerChanged: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toContain('/api/proposals/prepare');
    expect(requests.some((entry) => entry.path.includes('/api/proposals/confirm'))).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: 'confirmation_required',
      proposalId: 'proposal-2',
      proposal: {
        proposalId: 'proposal-2',
      },
    });
  });

  it('emits canonical readable activity entries for proposal actions', async () => {
    const activities: unknown[] = [];
    const requestJson = vi.fn(async (path) => {
      if (path.startsWith('/api/proposals/prepare')) {
        return {
          status: 'confirmation_required',
          proposal: {
            proposalId: 'proposal-3',
            operation: 'CREATE_OBLIGATION',
            summary: 'Create credit for Bisi for NGN 10.',
            status: 'pending',
            createdAt: '2026-09-02T10:00:00.000Z',
            expiresAt: '2026-09-02T10:10:00.000Z',
            confirmedAt: null,
            cancelledAt: null,
          },
          message: 'Review this proposal before confirming.',
        };
      }

      if (path.startsWith('/api/proposals/cancel')) {
        return {
          status: 'cancelled',
          reasonCode: null,
          message: 'Proposal cancelled.',
          proposal: {
            proposalId: 'proposal-3',
            operation: 'SETTLE_OBLIGATION',
            summary: 'Settle the obligation for Bisi.',
            status: 'cancelled',
            createdAt: '2026-09-02T10:00:00.000Z',
            expiresAt: '2026-09-02T10:10:00.000Z',
            confirmedAt: null,
            cancelledAt: '2026-09-02T10:03:00.000Z',
          },
        };
      }

      throw new Error(`Unexpected request: ${path}`);
    });

    const tools = createTalliWebMcpTools({
      requestJson,
      getSessionId: () => 'demo',
      onActivity: (value: unknown) => activities.push(value),
      onProposalOutcome: vi.fn(),
    });
    const [, , , , , prepareTool, cancelTool] = tools;

    await requireTool(prepareTool).execute(
      {
        operation: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Bisi', aliases: [] },
        amount: { value: 10, currency: 'NGN' },
      },
      { signal: new AbortController().signal },
    );

    await requireTool(cancelTool).execute(
      { proposalId: 'proposal-3' },
      { signal: new AbortController().signal },
    );

    expect(activities).toHaveLength(2);
    for (const entry of activities) {
      expect(entry).toMatchObject({
        timestamp: expect.any(String),
        message: expect.any(String),
      });
      expect((entry as { message: string }).message).not.toBe('[object Object]');
    }
    expect(activities[0]).toMatchObject({
      message: 'Agent prepared a credit entry for review.',
    });
    expect(activities[1]).toMatchObject({
      message: 'You cancelled the settlement.',
    });
  });
});
