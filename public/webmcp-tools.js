const MAX_SEARCH_RESULTS = 6;
const MAX_BOUND_LIST = 5;
const MAX_OVERDUE_RESULTS = 6;
const MAX_HISTORY_RESULTS = 5;
const MAX_TOOL_LIMIT = 8;

function strictObject(properties, required) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description, minLength = 1) {
  return {
    type: 'string',
    minLength,
    description,
  };
}

function integerSchema(description, minimum, maximum) {
  return {
    type: 'integer',
    description,
    minimum,
    maximum,
  };
}

function customerMutationRefSchema() {
  return {
    oneOf: [
      strictObject(
        {
          kind: { type: 'string', const: 'new', description: 'Create a new customer.' },
          name: stringSchema('Customer name.', 1),
          aliases: {
            type: 'array',
            description: 'Optional customer aliases.',
            items: stringSchema('Alias.', 1),
            default: [],
          },
        },
        ['kind', 'name', 'aliases'],
      ),
      strictObject(
        {
          kind: { type: 'string', const: 'id', description: 'Use an exact customer id.' },
          customerId: stringSchema('Exact customer id.', 1),
        },
        ['kind', 'customerId'],
      ),
      strictObject(
        {
          kind: { type: 'string', const: 'name', description: 'Resolve by customer name.' },
          name: stringSchema('Customer name.', 1),
          allowCreate: {
            type: 'boolean',
            description: 'Allow creating a new customer if no match is found.',
            default: false,
          },
        },
        ['kind', 'name', 'allowCreate'],
      ),
    ],
  };
}

function obligationMutationRefSchema() {
  return {
    oneOf: [
      strictObject(
        {
          kind: { type: 'string', const: 'id', description: 'Use an exact obligation id.' },
          obligationId: stringSchema('Exact obligation id.', 1),
        },
        ['kind', 'obligationId'],
      ),
      strictObject(
        {
          kind: {
            type: 'string',
            const: 'latestOpenForCustomer',
            description: 'Use the latest open obligation for a customer.',
          },
          customer: customerMutationRefSchema(),
        },
        ['kind', 'customer'],
      ),
      strictObject(
        {
          kind: {
            type: 'string',
            const: 'latestForCustomer',
            description: 'Use the latest obligation for a customer.',
          },
          customer: customerMutationRefSchema(),
        },
        ['kind', 'customer'],
      ),
    ],
  };
}

function humanMoneySchema() {
  return strictObject(
    {
      value: {
        type: 'number',
        description: 'Human-friendly amount, such as 12.5.',
        exclusiveMinimum: 0,
      },
      currency: {
        type: 'string',
        description: 'Three-letter currency code.',
        pattern: '^[A-Z]{3}$',
      },
    },
    ['value', 'currency'],
  );
}

function readCustomerRefSchema() {
  return strictObject(
    {
      kind: {
        type: 'string',
        enum: ['id', 'name', 'alias'],
        description: 'How to resolve the customer.',
      },
      value: stringSchema('Customer id, name, or alias.', 1),
    },
    ['kind', 'value'],
  );
}

function serializeResult(result) {
  return JSON.stringify(result);
}

function toLimit(value, fallback, maximum) {
  const parsed = Number.isInteger(value) ? value : fallback;
  return Math.max(1, Math.min(maximum, parsed));
}

function normalizeQuery(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withSessionQuery(path, getSessionId) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}sessionId=${encodeURIComponent(getSessionId())}`;
}

function safeReasonCode(error, fallback = 'REQUEST_FAILED') {
  if (error && typeof error === 'object' && error.body && typeof error.body === 'object') {
    if (typeof error.body.reasonCode === 'string') {
      return error.body.reasonCode;
    }
    if (typeof error.body.errorCode === 'string') {
      return error.body.errorCode;
    }
  }
  if (error && typeof error === 'object' && typeof error.reasonCode === 'string') {
    return error.reasonCode;
  }
  return fallback;
}

function safeMessage(error, fallback) {
  if (error && typeof error === 'object' && error.body && typeof error.body === 'object') {
    if (typeof error.body.message === 'string' && error.body.message) {
      return error.body.message;
    }
  }
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return fallback;
}

function activityEntry(message) {
  return {
    timestamp: new Date().toISOString(),
    message,
  };
}

function buildBalanceIndex(ledger) {
  const balances = new Map();
  for (const obligation of ledger.obligations ?? []) {
    const current = balances.get(obligation.customerId) ?? 0;
    balances.set(obligation.customerId, current + (obligation.outstandingMinor ?? 0));
  }
  return balances;
}

function candidateFromCustomer(customer, balanceMinor) {
  return {
    customerId: customer.id,
    displayName: customer.displayName,
    aliases: customer.aliases?.length ? customer.aliases.slice(0, 2) : [],
    outstandingMinor: balanceMinor,
  };
}

function summarizeObligation(obligation) {
  return {
    obligationId: obligation.id,
    amountMinor: obligation.originalAmountMinor,
    outstandingMinor: obligation.outstandingMinor,
    dueAt: obligation.dueAt ?? null,
    status: obligation.status,
  };
}

function summarizeEvent(event) {
  switch (event.kind) {
    case 'customer.created':
      return {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: `Customer ${event.displayName} created.`,
      };
    case 'obligation.created':
      return {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: `Debt recorded for ${event.customerId}.`,
      };
    case 'payment.recorded':
      return {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: `Payment of ${event.amountMinor} recorded.`,
      };
    case 'obligation.corrected':
      return {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: 'Debt correction recorded.',
      };
    case 'decision.clarification_requested':
      return {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: 'Clarification was requested.',
      };
    case 'decision.no_action':
      return {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: event.reason ?? 'No action recorded.',
      };
    default:
      return {
        kind: 'unknown',
        timestamp: event.timestamp,
        summary: 'Ledger event recorded.',
      };
  }
}

function createToolError(message, reasonCode = 'REQUEST_FAILED') {
  return serializeResult({
    status: 'error',
    reasonCode,
    message,
  });
}

function buildProposalResponseMessage(response) {
  if (response.status === 'confirmation_required') {
    return {
      status: response.status,
      proposal: {
        proposalId: response.proposal.proposalId,
        operation: response.proposal.operation,
        summary: response.proposal.summary,
        status: response.proposal.status,
        createdAt: response.proposal.createdAt,
        expiresAt: response.proposal.expiresAt,
        confirmedAt: response.proposal.confirmedAt,
        cancelledAt: response.proposal.cancelledAt,
      },
      proposalId: response.proposal.proposalId,
      expiresAt: response.proposal.expiresAt,
      operation: response.proposal.operation,
      summary: response.proposal.summary,
      message: response.message,
      ledgerChanged: false,
    };
  }

  if (response.status === 'clarification_required') {
    return {
      status: response.status,
      reasonCode: response.reasonCode,
      message: response.message,
      candidates: response.candidates.map((candidate) => ({
        kind: candidate.kind,
        id: candidate.id,
        displayName: candidate.displayName,
      })),
      ledgerChanged: false,
    };
  }

  return {
    status: response.status,
    reasonCode: response.reasonCode,
    message: response.message,
    ledgerChanged: false,
  };
}

function formatConfirmStateMessage(response) {
  switch (response.status) {
    case 'confirmed':
      return `You confirmed: ${response.proposal?.summary ?? 'the proposal'}.`;
    case 'already_confirmed':
      return 'This proposal was already confirmed.';
    case 'cancelled':
      return 'Proposal cancelled.';
    case 'already_cancelled':
      return 'This proposal was already cancelled.';
    case 'expired':
      return 'This proposal expired before it could be confirmed.';
    case 'stale':
      return 'The ledger changed before confirmation.';
    case 'rejected':
      return response.message;
    default:
      return response.message ?? 'Nothing changed.';
  }
}

export function createTalliWebMcpTools(deps) {
  const { requestJson, getSessionId, onActivity = () => {}, onProposalOutcome = () => {} } = deps;

  async function ledgerSnapshot(signal) {
    return requestJson(withSessionQuery('/api/ledger', getSessionId), { signal });
  }

  async function customerHistory(customerId, signal) {
    return requestJson(
      withSessionQuery(`/api/customers/${encodeURIComponent(customerId)}`, getSessionId),
      {
        signal,
      },
    );
  }

  function resolveCustomerCandidates(ledger, input) {
    const query = normalizeQuery(input.value);
    if (!query) {
      return [];
    }

    const balances = buildBalanceIndex(ledger);
    const exactId = input.kind === 'id' ? input.value.trim() : null;
    const matches = [];

    for (const customer of ledger.customers ?? []) {
      const searchTerms = [customer.displayName, ...(customer.aliases ?? []), customer.id]
        .map(normalizeQuery)
        .filter(Boolean);
      const matched =
        (exactId && customer.id === exactId) ||
        searchTerms.some((term) => term.includes(query) || query.includes(term));
      if (!matched) {
        continue;
      }

      matches.push(candidateFromCustomer(customer, balances.get(customer.id) ?? 0));
    }

    return matches.sort((left, right) => {
      const balanceDelta = right.outstandingMinor - left.outstandingMinor;
      if (balanceDelta !== 0) {
        return balanceDelta;
      }
      return left.displayName.localeCompare(right.displayName);
    });
  }

  function buildReadClarification(candidates, message, reasonCode) {
    return serializeResult({
      status: 'clarification_required',
      reasonCode,
      message,
      candidates: candidates.slice(0, MAX_BOUND_LIST).map((candidate) => ({
        customerId: candidate.customerId,
        displayName: candidate.displayName,
        aliases: candidate.aliases,
        outstandingMinor: candidate.outstandingMinor,
      })),
      truncated: candidates.length > MAX_BOUND_LIST,
    });
  }

  async function searchCustomersExecute(input, { signal }) {
    try {
      const query = String(input.query ?? '').trim();
      const limit = toLimit(input.limit, MAX_SEARCH_RESULTS, MAX_TOOL_LIMIT);
      if (!query) {
        return serializeResult({
          status: 'rejected',
          reasonCode: 'INVALID_REQUEST',
          message: 'A search query is required.',
        });
      }

      const ledger = await ledgerSnapshot(signal);
      const balances = buildBalanceIndex(ledger);
      const normalizedQuery = normalizeQuery(query);
      const matchedCustomers = (ledger.customers ?? [])
        .map((customer) => {
          const terms = [customer.displayName, ...(customer.aliases ?? []), customer.id]
            .map(normalizeQuery)
            .filter(Boolean);
          const matchScore = terms.some((term) => term === normalizedQuery)
            ? 0
            : terms.some((term) => term.includes(normalizedQuery) || normalizedQuery.includes(term))
              ? 1
              : 2;
          return matchScore === 2
            ? null
            : {
                customerId: customer.id,
                displayName: customer.displayName,
                aliases: customer.aliases?.slice(0, 2) ?? [],
                outstandingMinor: balances.get(customer.id) ?? 0,
                matchScore,
              };
        })
        .filter(Boolean);
      const matches = [...matchedCustomers]
        .sort((left, right) => {
          const scoreDelta = left.matchScore - right.matchScore;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          const balanceDelta = right.outstandingMinor - left.outstandingMinor;
          if (balanceDelta !== 0) {
            return balanceDelta;
          }
          return left.displayName.localeCompare(right.displayName);
        })
        .slice(0, limit)
        .map(({ matchScore, ...entry }) => entry);

      onActivity(activityEntry('Agent searched customers.'));
      return serializeResult({
        status: 'ok',
        query,
        count: matchedCustomers.length,
        truncated: matchedCustomers.length > Math.min(matches.length, limit),
        results: matches.slice(0, limit),
      });
    } catch (error) {
      return createToolError(safeMessage(error, 'Talli could not search customers right now.'));
    }
  }

  async function getLedgerSummaryExecute(_, { signal }) {
    try {
      const ledger = await ledgerSnapshot(signal);
      const overdueCount = (ledger.obligations ?? []).filter((obligation) => {
        if (obligation.status !== 'open' || !obligation.dueAt) {
          return false;
        }
        const due = new Date(obligation.dueAt);
        return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
      }).length;

      onActivity(activityEntry('Agent checked the ledger summary.'));
      return serializeResult({
        status: 'ok',
        currency: ledger.currency,
        totalOutstandingMinor: ledger.totals?.openOutstandingMinor ?? 0,
        totalCollectedMinor: ledger.totals?.totalPaidMinor ?? 0,
        customerCount: ledger.customers?.length ?? 0,
        openObligationCount: (ledger.obligations ?? []).filter(
          (obligation) => obligation.status === 'open',
        ).length,
        overdueCount,
      });
    } catch (error) {
      return createToolError(
        safeMessage(error, 'Talli could not load the ledger summary right now.'),
      );
    }
  }

  async function getCustomerBalanceExecute(input, { signal }) {
    try {
      const customerRef = input.customer;
      if (
        !customerRef ||
        typeof customerRef.kind !== 'string' ||
        typeof customerRef.value !== 'string'
      ) {
        return serializeResult({
          status: 'rejected',
          reasonCode: 'INVALID_REQUEST',
          message: 'A customer reference is required.',
        });
      }

      const ledger = await ledgerSnapshot(signal);
      const candidates = resolveCustomerCandidates(ledger, customerRef);
      if (candidates.length === 0) {
        return serializeResult({
          status: 'rejected',
          reasonCode: 'UNKNOWN_CUSTOMER',
          message: 'No matching customer was found.',
        });
      }
      if (candidates.length > 1) {
        onActivity(activityEntry('Agent found multiple possible customers.'));
        return buildReadClarification(
          candidates,
          'Multiple customers match that reference. Talli did not guess.',
          'AMBIGUOUS_CUSTOMER',
        );
      }

      const customer = candidates[0];
      const obligations = (ledger.obligations ?? [])
        .filter((obligation) => obligation.customerId === customer.customerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const openObligations = obligations.filter((obligation) => obligation.status === 'open');

      onActivity(activityEntry('Agent checked a customer balance.'));
      return serializeResult({
        status: 'ok',
        currency: ledger.currency,
        customer,
        totalOutstandingMinor: customer.outstandingMinor,
        openObligations: openObligations.slice(0, MAX_BOUND_LIST).map(summarizeObligation),
        truncated: openObligations.length > MAX_BOUND_LIST,
      });
    } catch (error) {
      return createToolError(
        safeMessage(error, 'Talli could not load that customer balance right now.'),
      );
    }
  }

  async function getCustomerHistoryExecute(input, { signal }) {
    try {
      const customerRef = input.customer;
      if (
        !customerRef ||
        typeof customerRef.kind !== 'string' ||
        typeof customerRef.value !== 'string'
      ) {
        return serializeResult({
          status: 'rejected',
          reasonCode: 'INVALID_REQUEST',
          message: 'A customer reference is required.',
        });
      }

      const limit = toLimit(input.limit, MAX_HISTORY_RESULTS, MAX_TOOL_LIMIT);
      const ledger = await ledgerSnapshot(signal);
      const candidates = resolveCustomerCandidates(ledger, customerRef);
      if (candidates.length === 0) {
        return serializeResult({
          status: 'rejected',
          reasonCode: 'UNKNOWN_CUSTOMER',
          message: 'No matching customer was found.',
        });
      }
      if (candidates.length > 1) {
        onActivity(activityEntry('Agent found multiple possible customers.'));
        return buildReadClarification(
          candidates,
          'Multiple customers match that reference. Talli did not guess.',
          'AMBIGUOUS_CUSTOMER',
        );
      }

      const customer = candidates[0];
      const detail = await customerHistory(customer.customerId, signal);
      const openObligations = (detail.obligations ?? [])
        .filter((obligation) => obligation.status === 'open')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
        .map(summarizeObligation);
      const recentEvents = (detail.events ?? []).slice(-limit).map(summarizeEvent);
      const recentTurns = (detail.recentTurns ?? []).slice(-limit).map((turn) => ({
        turnId: turn.turnId,
        timestamp: turn.timestamp,
        message: turn.message,
        status: turn.status,
      }));

      onActivity(activityEntry('Agent reviewed customer history.'));
      return serializeResult({
        status: 'ok',
        customer,
        history: {
          openObligations,
          recentEvents,
          recentTurns,
        },
        truncated:
          (detail.obligations?.length ?? 0) > openObligations.length ||
          (detail.events?.length ?? 0) > recentEvents.length ||
          (detail.recentTurns?.length ?? 0) > recentTurns.length,
      });
    } catch (error) {
      return createToolError(
        safeMessage(error, 'Talli could not load that customer history right now.'),
      );
    }
  }

  async function listOverdueDebtsExecute(input, { signal }) {
    try {
      const limit = toLimit(input.limit, MAX_OVERDUE_RESULTS, MAX_TOOL_LIMIT);
      const ledger = await ledgerSnapshot(signal);
      const now = Date.now();
      const overdueMatches = (ledger.obligations ?? []).filter((obligation) => {
        if (obligation.status !== 'open' || !obligation.dueAt) {
          return false;
        }
        const due = new Date(obligation.dueAt);
        return !Number.isNaN(due.getTime()) && due.getTime() < now;
      });
      const overdue = overdueMatches
        .map((obligation) => ({
          customerId: obligation.customerId,
          customerName: obligation.customerName,
          obligationId: obligation.id,
          amountMinor: obligation.outstandingMinor,
          currency: ledger.currency,
          dueAt: obligation.dueAt,
          daysOverdue: Math.max(
            1,
            Math.ceil((now - new Date(obligation.dueAt).getTime()) / 86400000),
          ),
        }))
        .sort((left, right) => right.daysOverdue - left.daysOverdue)
        .slice(0, limit);

      onActivity(activityEntry('Agent checked overdue debts.'));
      return serializeResult({
        status: 'ok',
        currency: ledger.currency,
        count: overdueMatches.length,
        truncated: overdueMatches.length > overdue.length,
        results: overdue,
      });
    } catch (error) {
      return createToolError(safeMessage(error, 'Talli could not check overdue debts right now.'));
    }
  }

  async function prepareLedgerMutationExecute(input, { signal }) {
    try {
      const response = await requestJson(withSessionQuery('/api/proposals/prepare', getSessionId), {
        method: 'POST',
        body: JSON.stringify(input),
        signal,
      });
      const outcome = buildProposalResponseMessage(response);
      if (response.status === 'confirmation_required') {
        onActivity(activityEntry('Agent prepared a ledger change for review.'));
      } else if (response.status === 'clarification_required') {
        onActivity(activityEntry('Agent found ambiguity and did not guess.'));
      } else if (response.status === 'rejected') {
        onActivity(activityEntry('Agent tried a ledger change that Talli rejected.'));
      }
      onProposalOutcome(outcome);
      return serializeResult(outcome);
    } catch (error) {
      const result = {
        status: 'error',
        reasonCode: safeReasonCode(error),
        message: safeMessage(error, 'Talli could not prepare that ledger change right now.'),
      };
      onProposalOutcome(result);
      return serializeResult(result);
    }
  }

  async function cancelLedgerMutationExecute(input, { signal }) {
    try {
      if (!input || typeof input.proposalId !== 'string' || !input.proposalId.trim()) {
        return serializeResult({
          status: 'rejected',
          reasonCode: 'INVALID_REQUEST',
          message: 'A proposalId is required.',
        });
      }

      const response = await requestJson(withSessionQuery('/api/proposals/cancel', getSessionId), {
        method: 'POST',
        body: JSON.stringify({ proposalId: input.proposalId }),
        signal,
      });
      const outcome = {
        status: response.status,
        reasonCode: response.reasonCode ?? null,
        message: response.message,
        proposal: response.proposal ?? null,
      };
      if (response.status === 'cancelled' || response.status === 'already_cancelled') {
        onActivity(activityEntry('Agent cancelled a proposal.'));
      }
      onProposalOutcome(outcome);
      return serializeResult(outcome);
    } catch (error) {
      const result = {
        status: 'error',
        reasonCode: safeReasonCode(error),
        message: safeMessage(error, 'Talli could not cancel that proposal right now.'),
      };
      onProposalOutcome(result);
      return serializeResult(result);
    }
  }

  const tools = [
    {
      name: 'get_ledger_summary',
      description: 'Summarize the current ledger without changing any financial state.',
      inputSchema: strictObject({}, []),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: getLedgerSummaryExecute,
    },
    {
      name: 'search_customers',
      description: 'Search customers by name, alias, or id in the current ledger.',
      inputSchema: strictObject(
        {
          query: stringSchema('Search text for customer names or aliases.', 1),
          limit: integerSchema(`Maximum results, capped at ${MAX_TOOL_LIMIT}.`, 1, MAX_TOOL_LIMIT),
        },
        ['query'],
      ),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: searchCustomersExecute,
    },
    {
      name: 'get_customer_balance',
      description: 'Get the current balance for one customer, or ask for clarification if needed.',
      inputSchema: strictObject(
        {
          customer: readCustomerRefSchema(),
        },
        ['customer'],
      ),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: getCustomerBalanceExecute,
    },
    {
      name: 'get_customer_history',
      description: 'Get a compact recent history for one customer, with safe ambiguity handling.',
      inputSchema: strictObject(
        {
          customer: readCustomerRefSchema(),
          limit: integerSchema(
            `Maximum history items, capped at ${MAX_TOOL_LIMIT}.`,
            1,
            MAX_TOOL_LIMIT,
          ),
        },
        ['customer'],
      ),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: getCustomerHistoryExecute,
    },
    {
      name: 'list_overdue_debts',
      description: 'List overdue open debts with bounded, same-session results.',
      inputSchema: strictObject(
        {
          limit: integerSchema(`Maximum rows, capped at ${MAX_TOOL_LIMIT}.`, 1, MAX_TOOL_LIMIT),
        },
        [],
      ),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: listOverdueDebtsExecute,
    },
    {
      name: 'prepare_ledger_mutation',
      description:
        'Prepare a credit, payment, or settlement for human review without mutating the ledger.',
      inputSchema: {
        oneOf: [
          strictObject(
            {
              operation: { type: 'string', const: 'CREATE_OBLIGATION' },
              customer: customerMutationRefSchema(),
              amount: humanMoneySchema(),
              dueAt: {
                type: ['string', 'null'],
                description: 'Optional due date.',
                format: 'date-time',
              },
            },
            ['operation', 'customer', 'amount'],
          ),
          strictObject(
            {
              operation: { type: 'string', const: 'RECORD_PAYMENT' },
              customer: customerMutationRefSchema(),
              obligation: obligationMutationRefSchema(),
              amount: humanMoneySchema(),
              settleRemaining: {
                type: 'boolean',
                description: 'Set true to record the remaining balance.',
                default: false,
              },
            },
            ['operation', 'settleRemaining'],
          ),
          strictObject(
            {
              operation: { type: 'string', const: 'SETTLE_OBLIGATION' },
              obligation: obligationMutationRefSchema(),
              amount: humanMoneySchema(),
            },
            ['operation', 'obligation'],
          ),
        ],
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: prepareLedgerMutationExecute,
    },
    {
      name: 'cancel_ledger_mutation',
      description:
        'Cancel the current pending proposal for this session without changing the ledger.',
      inputSchema: strictObject(
        {
          proposalId: stringSchema('Opaque proposal id.', 1),
        },
        ['proposalId'],
      ),
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
      },
      execute: cancelLedgerMutationExecute,
    },
  ];

  return tools;
}

let registrationPromise = null;
let registrationController = null;
let registrationAttempted = false;

export async function registerTalliWebMcpTools({ document: doc = globalThis.document, ...deps }) {
  if (registrationAttempted) {
    return registrationPromise ?? false;
  }

  registrationAttempted = true;
  const modelContext = doc?.modelContext;
  if (!modelContext?.registerTool) {
    return false;
  }

  registrationController = new AbortController();
  const tools = createTalliWebMcpTools(deps);
  registrationPromise = (async () => {
    for (const tool of tools) {
      await modelContext.registerTool(tool, { signal: registrationController.signal });
    }
    return true;
  })().catch((error) => {
    void error;
    return false;
  });

  return registrationPromise;
}

export function abortTalliWebMcpTools() {
  registrationController?.abort();
}

export function resetTalliWebMcpToolsForTests() {
  registrationPromise = null;
  registrationController = null;
  registrationAttempted = false;
}
