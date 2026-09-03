import { randomUUID } from 'node:crypto';
import type {
  CorrectObligationAction,
  CreateObligationAction,
  CustomerRef,
  LedgerAction,
  ObligationRef,
  RecordPaymentAction,
  RequestClarificationAction,
  SettleObligationAction,
} from './actions.js';
import { formatMinorUnits } from './money.js';

export type LedgerCurrency = string;
export type LedgerEventKind =
  | 'customer.created'
  | 'obligation.created'
  | 'payment.recorded'
  | 'obligation.corrected'
  | 'decision.clarification_requested'
  | 'decision.no_action';

export interface LedgerEventBase {
  id: string;
  kind: LedgerEventKind;
  timestamp: string;
  sourceText?: string;
  turnId?: string;
  actor: 'system' | 'user' | 'baseline' | 'advanced';
}

export interface CustomerCreatedEvent extends LedgerEventBase {
  kind: 'customer.created';
  customerId: string;
  displayName: string;
  aliases: string[];
}

export interface ObligationCreatedEvent extends LedgerEventBase {
  kind: 'obligation.created';
  customerId: string;
  obligationId: string;
  originalAmountMinor: number;
  dueAt?: string | null;
}

export interface PaymentRecordedEvent extends LedgerEventBase {
  kind: 'payment.recorded';
  customerId: string;
  obligationId: string;
  amountMinor: number;
  outstandingBeforeMinor: number;
  outstandingAfterMinor: number;
}

export interface ObligationCorrectedEvent extends LedgerEventBase {
  kind: 'obligation.corrected';
  customerId: string;
  obligationId: string;
  previousAmountMinor: number;
  correctedAmountMinor: number;
  previousOutstandingMinor: number;
  correctedOutstandingMinor: number;
  sourceEventId: string;
}

export interface ClarificationRequestedEvent extends LedgerEventBase {
  kind: 'decision.clarification_requested';
  question: string;
  ambiguityKind?: RequestClarificationAction['ambiguityKind'];
  candidateCustomerIds: string[];
  candidateObligationIds: string[];
}

export interface NoActionEvent extends LedgerEventBase {
  kind: 'decision.no_action';
  reason?: string;
}

export type LedgerEvent =
  | CustomerCreatedEvent
  | ObligationCreatedEvent
  | PaymentRecordedEvent
  | ObligationCorrectedEvent
  | ClarificationRequestedEvent
  | NoActionEvent;

export interface CustomerRecord {
  id: string;
  displayName: string;
  aliases: string[];
  normalizedNames: string[];
  createdAt: string;
  updatedAt: string;
  sourceEventIds: string[];
}

export type ObligationStatus = 'open' | 'settled';

export interface ObligationRecord {
  id: string;
  customerId: string;
  customerName: string;
  originalAmountMinor: number;
  totalPaidMinor: number;
  outstandingMinor: number;
  status: ObligationStatus;
  createdAt: string;
  updatedAt: string;
  dueAt?: string | null;
  sourceEventIds: string[];
  paymentEventIds: string[];
  correctionEventIds: string[];
}

export interface LedgerDocument {
  id: string;
  currency: LedgerCurrency;
  events: LedgerEvent[];
}

export interface LedgerSnapshot {
  id: string;
  currency: LedgerCurrency;
  customers: CustomerRecord[];
  obligations: ObligationRecord[];
  totals: {
    openOutstandingMinor: number;
    settledOutstandingMinor: number;
    totalPaidMinor: number;
  };
}

export interface ResolveContext {
  now: Date;
  turnId?: string;
  sourceText?: string;
  actor?: LedgerEventBase['actor'];
  idFactory?: () => string;
}

export interface ApplyResult {
  applied: boolean;
  financialMutation: boolean;
  reason?: string;
  event?: LedgerEvent;
  events: LedgerEvent[];
  document: LedgerDocument;
  snapshot: LedgerSnapshot;
  clarification?: {
    question: string;
    ambiguityKind?: RequestClarificationAction['ambiguityKind'];
    candidateCustomerIds: string[];
    candidateObligationIds: string[];
  };
}

const DEFAULT_ACTOR: LedgerEventBase['actor'] = 'system';

export function createLedgerDocument(
  id: string = randomUUID(),
  currency: LedgerCurrency = 'NGN',
): LedgerDocument {
  return {
    id,
    currency,
    events: [],
  };
}

export function createIdFactory(prefix = 'evt'): () => string {
  let counter = 0;
  return () => `${prefix}_${String(++counter).padStart(4, '0')}`;
}

export function normalizeLedgerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ');
}

export function projectLedger(document: LedgerDocument): LedgerSnapshot {
  const customers: CustomerRecord[] = [];
  const obligations: ObligationRecord[] = [];
  const customerIndex = new Map<string, CustomerRecord>();
  const obligationIndex = new Map<string, ObligationRecord>();

  for (const event of document.events) {
    switch (event.kind) {
      case 'customer.created': {
        const customer: CustomerRecord = {
          id: event.customerId,
          displayName: event.displayName,
          aliases: [...event.aliases],
          normalizedNames: [event.displayName, ...event.aliases].map(normalizeLedgerName),
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          sourceEventIds: [event.id],
        };
        customers.push(customer);
        customerIndex.set(customer.id, customer);
        break;
      }
      case 'obligation.created': {
        const customer = customerIndex.get(event.customerId);
        if (!customer) {
          throw new Error(
            `Obligation ${event.obligationId} references missing customer ${event.customerId}`,
          );
        }

        const obligation: ObligationRecord = {
          id: event.obligationId,
          customerId: event.customerId,
          customerName: customer.displayName,
          originalAmountMinor: event.originalAmountMinor,
          totalPaidMinor: 0,
          outstandingMinor: event.originalAmountMinor,
          status: event.originalAmountMinor === 0 ? 'settled' : 'open',
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          dueAt: event.dueAt ?? null,
          sourceEventIds: [event.id],
          paymentEventIds: [],
          correctionEventIds: [],
        };
        obligations.push(obligation);
        obligationIndex.set(obligation.id, obligation);
        break;
      }
      case 'payment.recorded': {
        const obligation = obligationIndex.get(event.obligationId);
        if (!obligation) {
          throw new Error(`Payment references missing obligation ${event.obligationId}`);
        }
        obligation.totalPaidMinor += event.amountMinor;
        obligation.outstandingMinor = event.outstandingAfterMinor;
        obligation.status = obligation.outstandingMinor === 0 ? 'settled' : 'open';
        obligation.updatedAt = event.timestamp;
        obligation.paymentEventIds.push(event.id);
        obligation.sourceEventIds.push(event.id);
        break;
      }
      case 'obligation.corrected': {
        const obligation = obligationIndex.get(event.obligationId);
        if (!obligation) {
          throw new Error(`Correction references missing obligation ${event.obligationId}`);
        }
        obligation.originalAmountMinor = event.correctedAmountMinor;
        obligation.outstandingMinor = event.correctedOutstandingMinor;
        obligation.status = obligation.outstandingMinor === 0 ? 'settled' : 'open';
        obligation.updatedAt = event.timestamp;
        obligation.correctionEventIds.push(event.id);
        obligation.sourceEventIds.push(event.id);
        break;
      }
      case 'decision.clarification_requested':
      case 'decision.no_action':
        break;
      default: {
        const never: never = event as never;
        void never;
      }
    }
  }

  const totals = obligations.reduce(
    (acc, obligation) => {
      acc.totalPaidMinor += obligation.totalPaidMinor;
      if (obligation.status === 'settled') {
        acc.settledOutstandingMinor += obligation.outstandingMinor;
      } else {
        acc.openOutstandingMinor += obligation.outstandingMinor;
      }
      return acc;
    },
    {
      openOutstandingMinor: 0,
      settledOutstandingMinor: 0,
      totalPaidMinor: 0,
    },
  );

  return {
    id: document.id,
    currency: document.currency,
    customers,
    obligations,
    totals,
  };
}

export function validateLedgerSnapshot(snapshot: LedgerSnapshot): void {
  for (const customer of snapshot.customers) {
    if (!customer.id || !customer.displayName) {
      throw new Error('Customer records must contain an id and display name.');
    }
  }

  for (const obligation of snapshot.obligations) {
    if (obligation.originalAmountMinor < 0) {
      throw new Error(`Obligation ${obligation.id} has a negative original amount.`);
    }
    if (obligation.totalPaidMinor < 0) {
      throw new Error(`Obligation ${obligation.id} has a negative paid total.`);
    }
    if (obligation.outstandingMinor < 0) {
      throw new Error(`Obligation ${obligation.id} has a negative outstanding balance.`);
    }
    if (obligation.totalPaidMinor > obligation.originalAmountMinor) {
      throw new Error(
        `Obligation ${obligation.id} recorded more payments than the current obligation amount.`,
      );
    }
    if ((obligation.outstandingMinor === 0) !== (obligation.status === 'settled')) {
      throw new Error(
        `Obligation ${obligation.id} settled state does not match its outstanding balance.`,
      );
    }
    if (
      obligation.originalAmountMinor - obligation.totalPaidMinor !==
      obligation.outstandingMinor
    ) {
      throw new Error(`Obligation ${obligation.id} balance is inconsistent.`);
    }
  }
}

export function assertLedgerInvariants(snapshot: LedgerSnapshot): void {
  validateLedgerSnapshot(snapshot);
}

export function resolveCustomerCandidates(
  snapshot: LedgerSnapshot,
  customer: CustomerRef | undefined,
):
  | { kind: 'resolved'; customer: CustomerRecord }
  | { kind: 'ambiguous'; candidateCustomerIds: string[] }
  | { kind: 'missing' } {
  if (!customer) {
    return { kind: 'missing' };
  }

  if (customer.kind === 'id') {
    const found = snapshot.customers.find((entry) => entry.id === customer.customerId);
    if (!found) {
      return { kind: 'missing' };
    }
    return { kind: 'resolved', customer: found };
  }

  if (customer.kind === 'ambiguous') {
    return { kind: 'ambiguous', candidateCustomerIds: [...customer.candidateCustomerIds] };
  }

  const name = normalizeLedgerName(customer.name);
  const exactMatches = snapshot.customers.filter((entry) => entry.normalizedNames.includes(name));

  if (exactMatches.length === 1) {
    const single = exactMatches[0];
    if (!single) {
      return { kind: 'missing' };
    }
    return { kind: 'resolved', customer: single };
  }

  if (exactMatches.length > 1) {
    return {
      kind: 'ambiguous',
      candidateCustomerIds: exactMatches.map((entry) => entry.id),
    };
  }

  const partialMatches = snapshot.customers.filter((entry) =>
    entry.normalizedNames.some((term) => term.includes(name) || name.includes(term)),
  );

  if (partialMatches.length > 0) {
    return {
      kind: 'ambiguous',
      candidateCustomerIds: partialMatches.map((entry) => entry.id),
    };
  }

  return { kind: 'missing' };
}

export function selectObligationFromRef(
  snapshot: LedgerSnapshot,
  obligation: ObligationRef | undefined,
  customer?: CustomerRecord,
  document?: LedgerDocument,
):
  | { kind: 'resolved'; obligation: ObligationRecord }
  | { kind: 'ambiguous'; candidateObligationIds: string[] }
  | { kind: 'missing' } {
  if (!obligation) {
    return { kind: 'missing' };
  }

  if (obligation.kind === 'id') {
    const found = snapshot.obligations.find((entry) => entry.id === obligation.obligationId);
    if (!found) {
      return { kind: 'missing' };
    }
    return { kind: 'resolved', obligation: found };
  }

  if (obligation.kind === 'ambiguous') {
    return { kind: 'ambiguous', candidateObligationIds: [...obligation.candidateObligationIds] };
  }

  if (obligation.kind === 'reference') {
    if (!document || !obligation.previousTurnId) {
      return { kind: 'missing' };
    }

    const referencedObligationIds = document.events
      .filter(
        (event): event is ObligationCreatedEvent =>
          event.kind === 'obligation.created' && event.turnId === obligation.previousTurnId,
      )
      .map((event) => event.obligationId);

    if (referencedObligationIds.length === 1) {
      const referenced = snapshot.obligations.find(
        (entry) => entry.id === referencedObligationIds[0],
      );
      if (referenced) {
        return { kind: 'resolved', obligation: referenced };
      }
      return { kind: 'missing' };
    }

    if (referencedObligationIds.length > 1) {
      return {
        kind: 'ambiguous',
        candidateObligationIds: referencedObligationIds,
      };
    }

    return { kind: 'missing' };
  }

  const customerResolution = resolveCustomerCandidates(snapshot, obligation.customer);
  if (customerResolution.kind !== 'resolved') {
    return customerResolution.kind === 'ambiguous'
      ? { kind: 'ambiguous', candidateObligationIds: customerResolution.candidateCustomerIds }
      : { kind: 'missing' };
  }

  const resolvedCustomer = customer ?? customerResolution.customer;
  if (!resolvedCustomer) {
    return { kind: 'missing' };
  }
  const customerObligations = snapshot.obligations.filter(
    (entry) => entry.customerId === resolvedCustomer.id,
  );

  if (customerObligations.length === 0) {
    return { kind: 'missing' };
  }

  if (obligation.kind === 'latestOpenForCustomer') {
    const openObligations = customerObligations.filter((entry) => entry.status === 'open');
    if (openObligations.length === 1) {
      const single = openObligations[0];
      if (!single) {
        return { kind: 'missing' };
      }
      return { kind: 'resolved', obligation: single };
    }
    if (openObligations.length > 1) {
      return {
        kind: 'ambiguous',
        candidateObligationIds: openObligations.map((entry) => entry.id),
      };
    }
    return { kind: 'missing' };
  }

  const latest = [...customerObligations]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  if (!latest) {
    return { kind: 'missing' };
  }
  return { kind: 'resolved', obligation: latest };
}

function nextEventId(context: ResolveContext): string {
  return context.idFactory?.() ?? randomUUID();
}

function createEventBase(
  kind: LedgerEventKind,
  context: ResolveContext,
  extra: Record<string, unknown> = {},
): LedgerEventBase {
  return {
    id: nextEventId(context),
    kind,
    timestamp: context.now.toISOString(),
    actor: context.actor ?? DEFAULT_ACTOR,
    sourceText: context.sourceText,
    turnId: context.turnId,
    ...extra,
  };
}

export function applyLedgerAction(
  document: LedgerDocument,
  action: LedgerAction,
  context: ResolveContext,
): ApplyResult {
  const snapshot = projectLedger(document);

  switch (action.type) {
    case 'CREATE_OBLIGATION':
      return applyCreateObligation(document, snapshot, action, context);
    case 'RECORD_PAYMENT':
      return applyRecordPayment(document, snapshot, action, context);
    case 'CORRECT_OBLIGATION':
      return applyCorrectObligation(document, snapshot, action, context);
    case 'SETTLE_OBLIGATION':
      return applySettleObligation(document, snapshot, action, context);
    case 'REQUEST_CLARIFICATION':
      return recordClarification(document, snapshot, action, context);
    case 'NO_ACTION':
      return recordNoAction(document, snapshot, action, context);
    default: {
      const never: never = action;
      return never;
    }
  }
}

function appendEvents(document: LedgerDocument, events: LedgerEvent[]): LedgerDocument {
  return {
    ...document,
    events: [...document.events, ...events],
  };
}

function clarificationResult(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: {
    question: string;
    ambiguityKind?: RequestClarificationAction['ambiguityKind'];
    candidateCustomerIds: string[];
    candidateObligationIds: string[];
  } & Record<string, unknown>,
  context: ResolveContext,
  reason: string,
): ApplyResult {
  const event: ClarificationRequestedEvent = {
    ...(createEventBase('decision.clarification_requested', context, {
      question: action.question,
      candidateCustomerIds: [...action.candidateCustomerIds],
      candidateObligationIds: [...action.candidateObligationIds],
    }) as unknown as ClarificationRequestedEvent),
    question: action.question,
    ambiguityKind: action.ambiguityKind,
    candidateCustomerIds: [...action.candidateCustomerIds],
    candidateObligationIds: [...action.candidateObligationIds],
  };

  const nextDocument = appendEvents(document, [event]);
  return {
    applied: false,
    financialMutation: false,
    reason,
    event,
    events: [event],
    document: nextDocument,
    snapshot,
    clarification: {
      question: action.question,
      ambiguityKind: action.ambiguityKind,
      candidateCustomerIds: [...action.candidateCustomerIds],
      candidateObligationIds: [...action.candidateObligationIds],
    },
  };
}

function recordClarification(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: RequestClarificationAction,
  context: ResolveContext,
): ApplyResult {
  return clarificationResult(document, snapshot, action, context, action.question);
}

function recordNoAction(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: { reason?: string },
  context: ResolveContext,
): ApplyResult {
  const eventBase = createEventBase(
    'decision.no_action',
    context,
    action.reason ? { reason: action.reason } : {},
  );
  const event: NoActionEvent = action.reason
    ? ({ ...eventBase, reason: action.reason } as NoActionEvent)
    : (eventBase as NoActionEvent);

  const nextDocument = appendEvents(document, [event]);
  return {
    applied: true,
    financialMutation: false,
    ...(action.reason ? { reason: action.reason } : {}),
    event,
    events: [event],
    document: nextDocument,
    snapshot,
  };
}

function ensureCustomer(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  customerRef: CustomerRef,
  context: ResolveContext,
): {
  document: LedgerDocument;
  snapshot: LedgerSnapshot;
  customer?: CustomerRecord;
  clarification?: ApplyResult;
} {
  const resolution = resolveCustomerCandidates(snapshot, customerRef);

  if (resolution.kind === 'resolved') {
    const customer = resolution.customer;
    if (!customer) {
      return { document, snapshot };
    }
    return { document, snapshot, customer };
  }

  if (resolution.kind === 'ambiguous') {
    const clarification = clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'Which customer did you mean?',
        ambiguityKind: 'customer',
        candidateCustomerIds: resolution.candidateCustomerIds,
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Ambiguous customer reference',
    );
    return { document: clarification.document, snapshot: clarification.snapshot, clarification };
  }

  if (customerRef.kind === 'new' || (customerRef.kind === 'name' && customerRef.allowCreate)) {
    const customerId = context.idFactory?.() ?? randomUUID();
    const event: CustomerCreatedEvent = {
      ...(createEventBase('customer.created', context, {
        customerId,
        displayName: customerRef.kind === 'new' ? customerRef.name : customerRef.name,
        aliases: customerRef.kind === 'new' ? customerRef.aliases : [],
      }) as unknown as CustomerCreatedEvent),
      customerId,
      displayName: customerRef.kind === 'new' ? customerRef.name : customerRef.name,
      aliases: customerRef.kind === 'new' ? customerRef.aliases : [],
    };
    const nextDocument = appendEvents(document, [event]);
    const nextSnapshot = projectLedger(nextDocument);
    return {
      document: nextDocument,
      snapshot: nextSnapshot,
      customer: nextSnapshot.customers.find((entry) => entry.id === customerId),
    };
  }

  return {
    document,
    snapshot,
    clarification: clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I need a customer identity to continue.',
        ambiguityKind: 'customer',
        candidateCustomerIds: [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Customer could not be resolved safely',
    ),
  };
}

function applyCreateObligation(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: CreateObligationAction,
  context: ResolveContext,
): ApplyResult {
  const ensuredCustomer = ensureCustomer(document, snapshot, action.customer, context);
  if (ensuredCustomer.clarification) {
    return ensuredCustomer.clarification;
  }

  const customer = ensuredCustomer.customer;
  if (!customer) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I could not resolve the customer for the new debt.',
        ambiguityKind: 'customer',
        candidateCustomerIds: [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Customer resolution failed',
    );
  }

  const obligationId = context.idFactory?.() ?? randomUUID();
  const event: ObligationCreatedEvent = {
    ...(createEventBase('obligation.created', context, {
      customerId: customer.id,
      obligationId,
      originalAmountMinor: action.amountMinor,
      dueAt: action.dueAt ?? null,
    }) as unknown as ObligationCreatedEvent),
    customerId: customer.id,
    obligationId,
    originalAmountMinor: action.amountMinor,
    dueAt: action.dueAt ?? null,
  };
  const nextDocument = appendEvents(ensuredCustomer.document, [event]);
  const nextSnapshot = projectLedger(nextDocument);
  assertLedgerInvariants(nextSnapshot);
  return {
    applied: true,
    financialMutation: true,
    event,
    events: [event],
    document: nextDocument,
    snapshot: nextSnapshot,
  };
}

function applyRecordPayment(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: RecordPaymentAction,
  context: ResolveContext,
): ApplyResult {
  const customerResolution = action.customer
    ? resolveCustomerCandidates(snapshot, action.customer)
    : { kind: 'missing' as const };
  let customer: CustomerRecord | undefined;

  if (customerResolution.kind === 'resolved') {
    customer = customerResolution.customer;
  } else if (customerResolution.kind === 'ambiguous') {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'Which customer did you mean?',
        ambiguityKind: 'customer',
        candidateCustomerIds: customerResolution.candidateCustomerIds,
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Ambiguous customer reference',
    );
  }

  let obligationResolution = action.obligation
    ? selectObligationFromRef(snapshot, action.obligation, customer, document)
    : { kind: 'missing' as const };

  if (obligationResolution.kind === 'ambiguous') {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'Which obligation should I apply this payment to?',
        ambiguityKind: 'obligation',
        candidateCustomerIds: [],
        candidateObligationIds: obligationResolution.candidateObligationIds,
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Ambiguous obligation reference',
    );
  }

  if (obligationResolution.kind === 'resolved') {
    const resolvedObligation = obligationResolution.obligation;
    if (resolvedObligation && customer && customer.id !== resolvedObligation.customerId) {
      return clarificationResult(
        document,
        snapshot,
        {
          type: 'REQUEST_CLARIFICATION',
          question: 'Which customer made this payment?',
          ambiguityKind: 'customer',
          candidateCustomerIds: [resolvedObligation.customerId],
          candidateObligationIds: [resolvedObligation.id],
          permittedMutation: false,
          evidence: [],
          source: context.sourceText,
        },
        context,
        'Customer and obligation did not match',
      );
    }

    if (!customer) {
      customer = snapshot.customers.find((entry) => entry.id === resolvedObligation.customerId);
    }
  }

  if (obligationResolution.kind === 'missing') {
    const implicitCustomer = action.customer
      ? ensureCustomer(document, snapshot, action.customer, context)
      : undefined;
    if (implicitCustomer?.clarification) {
      return implicitCustomer.clarification;
    }
    customer = implicitCustomer?.customer ?? customer;

    if (!customer) {
      return clarificationResult(
        document,
        snapshot,
        {
          type: 'REQUEST_CLARIFICATION',
          question: 'Which customer made this payment?',
          ambiguityKind: 'customer',
          candidateCustomerIds: [],
          candidateObligationIds: [],
          permittedMutation: false,
          evidence: [],
          source: context.sourceText,
        },
        context,
        'Missing customer reference',
      );
    }

    const resolvedCustomer = customer;
    const customerObligations = snapshot.obligations.filter(
      (entry) => entry.customerId === resolvedCustomer.id,
    );
    const openObligations = customerObligations.filter((entry) => entry.status === 'open');
    if (openObligations.length === 1) {
      const single = openObligations[0];
      if (single) {
        obligationResolution = { kind: 'resolved', obligation: single };
      }
    } else if (openObligations.length > 1) {
      return clarificationResult(
        document,
        snapshot,
        {
          type: 'REQUEST_CLARIFICATION',
          question: 'Which debt should I apply the payment to?',
          ambiguityKind: 'obligation',
          candidateCustomerIds: [],
          candidateObligationIds: openObligations.map((entry) => entry.id),
          permittedMutation: false,
          evidence: [],
          source: context.sourceText,
        },
        context,
        'Multiple open obligations for one customer',
      );
    }

    if (customerObligations.length === 1) {
      const single = customerObligations[0];
      if (single) {
        obligationResolution = { kind: 'resolved', obligation: single };
      }
    }
  }

  if (obligationResolution.kind !== 'resolved') {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I could not resolve the target debt for this payment.',
        ambiguityKind: 'obligation',
        candidateCustomerIds: customer ? [customer.id] : [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Missing obligation reference',
    );
  }

  if (!customer) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'Which customer made this payment?',
        ambiguityKind: 'customer',
        candidateCustomerIds: [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Missing customer reference',
    );
  }

  const resolvedCustomer = customer;
  const obligation = obligationResolution.obligation;
  const amountMinor =
    action.amountMinor ?? (action.settleRemaining ? obligation.outstandingMinor : undefined);
  if (amountMinor === undefined) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'How much was paid?',
        ambiguityKind: 'amount',
        candidateCustomerIds: [resolvedCustomer.id],
        candidateObligationIds: [obligation.id],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Missing payment amount',
    );
  }

  if (amountMinor <= 0) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'Payment amount must be greater than zero.',
        ambiguityKind: 'amount',
        candidateCustomerIds: customer ? [customer.id] : [],
        candidateObligationIds: [obligation.id],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Invalid payment amount',
    );
  }

  if (amountMinor > obligation.outstandingMinor) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question:
          'This payment is larger than the remaining balance. Should I treat it as an overpayment?',
        ambiguityKind: 'amount',
        candidateCustomerIds: customer ? [customer.id] : [],
        candidateObligationIds: [obligation.id],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Overpayment would be unsafe',
    );
  }

  const event: PaymentRecordedEvent = {
    ...(createEventBase('payment.recorded', context, {
      customerId: obligation.customerId,
      obligationId: obligation.id,
      amountMinor,
      outstandingBeforeMinor: obligation.outstandingMinor,
      outstandingAfterMinor: obligation.outstandingMinor - amountMinor,
    }) as unknown as PaymentRecordedEvent),
    customerId: obligation.customerId,
    obligationId: obligation.id,
    amountMinor,
    outstandingBeforeMinor: obligation.outstandingMinor,
    outstandingAfterMinor: obligation.outstandingMinor - amountMinor,
  };
  const nextDocument = appendEvents(document, [event]);
  const nextSnapshot = projectLedger(nextDocument);
  assertLedgerInvariants(nextSnapshot);
  return {
    applied: true,
    financialMutation: true,
    event,
    events: [event],
    document: nextDocument,
    snapshot: nextSnapshot,
  };
}

function applyCorrectObligation(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: CorrectObligationAction,
  context: ResolveContext,
): ApplyResult {
  const obligationResolution = selectObligationFromRef(
    snapshot,
    action.obligation,
    undefined,
    document,
  );
  if (obligationResolution.kind === 'ambiguous') {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'Which obligation should I correct?',
        ambiguityKind: 'obligation',
        candidateCustomerIds: [],
        candidateObligationIds: obligationResolution.candidateObligationIds,
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Ambiguous correction target',
    );
  }

  if (obligationResolution.kind === 'missing') {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I could not find the obligation to correct.',
        ambiguityKind: 'obligation',
        candidateCustomerIds: [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Missing correction target',
    );
  }

  const obligation = obligationResolution.obligation;
  if (!obligation) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I could not find the obligation to correct.',
        ambiguityKind: 'obligation',
        candidateCustomerIds: [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Missing correction target',
    );
  }
  if (action.correctedAmountMinor < obligation.totalPaidMinor) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question:
          'The corrected amount is less than the money already paid. Please confirm how to handle the overpayment.',
        ambiguityKind: 'correction',
        candidateCustomerIds: [obligation.customerId],
        candidateObligationIds: [obligation.id],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Correction would create an overpayment',
    );
  }

  const correctedOutstandingMinor = action.correctedAmountMinor - obligation.totalPaidMinor;
  const event: ObligationCorrectedEvent = {
    ...(createEventBase('obligation.corrected', context, {
      customerId: obligation.customerId,
      obligationId: obligation.id,
      previousAmountMinor: obligation.originalAmountMinor,
      correctedAmountMinor: action.correctedAmountMinor,
      previousOutstandingMinor: obligation.outstandingMinor,
      correctedOutstandingMinor,
      sourceEventId: obligation.sourceEventIds[0] ?? obligation.id,
    }) as unknown as ObligationCorrectedEvent),
    customerId: obligation.customerId,
    obligationId: obligation.id,
    previousAmountMinor: obligation.originalAmountMinor,
    correctedAmountMinor: action.correctedAmountMinor,
    previousOutstandingMinor: obligation.outstandingMinor,
    correctedOutstandingMinor,
    sourceEventId: obligation.sourceEventIds[0] ?? obligation.id,
  };
  const nextDocument = appendEvents(document, [event]);
  const nextSnapshot = projectLedger(nextDocument);
  assertLedgerInvariants(nextSnapshot);
  return {
    applied: true,
    financialMutation: true,
    event,
    events: [event],
    document: nextDocument,
    snapshot: nextSnapshot,
  };
}

function applySettleObligation(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  action: SettleObligationAction,
  context: ResolveContext,
): ApplyResult {
  const obligationResolution = selectObligationFromRef(
    snapshot,
    action.obligation,
    undefined,
    document,
  );
  if (obligationResolution.kind !== 'resolved') {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I could not safely resolve the debt to settle.',
        ambiguityKind: 'obligation',
        candidateCustomerIds: [],
        candidateObligationIds:
          obligationResolution.kind === 'ambiguous'
            ? obligationResolution.candidateObligationIds
            : [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      obligationResolution.kind === 'ambiguous'
        ? 'Ambiguous settlement target'
        : 'Missing settlement target',
    );
  }

  const obligation = obligationResolution.obligation;
  if (!obligation) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'I could not safely resolve the debt to settle.',
        ambiguityKind: 'obligation',
        candidateCustomerIds: [],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Missing settlement target',
    );
  }
  const amountMinor = action.amountMinor ?? obligation.outstandingMinor;
  if (amountMinor !== obligation.outstandingMinor) {
    return clarificationResult(
      document,
      snapshot,
      {
        type: 'REQUEST_CLARIFICATION',
        question: 'The settlement amount does not match the remaining balance.',
        ambiguityKind: 'amount',
        candidateCustomerIds: [obligation.customerId],
        candidateObligationIds: [obligation.id],
        permittedMutation: false,
        evidence: [],
        source: context.sourceText,
      },
      context,
      'Settlement amount mismatch',
    );
  }

  const event: PaymentRecordedEvent = {
    ...(createEventBase('payment.recorded', context, {
      customerId: obligation.customerId,
      obligationId: obligation.id,
      amountMinor,
      outstandingBeforeMinor: obligation.outstandingMinor,
      outstandingAfterMinor: 0,
    }) as unknown as PaymentRecordedEvent),
    customerId: obligation.customerId,
    obligationId: obligation.id,
    amountMinor,
    outstandingBeforeMinor: obligation.outstandingMinor,
    outstandingAfterMinor: 0,
  };
  const nextDocument = appendEvents(document, [event]);
  const nextSnapshot = projectLedger(nextDocument);
  assertLedgerInvariants(nextSnapshot);
  return {
    applied: true,
    financialMutation: true,
    event,
    events: [event],
    document: nextDocument,
    snapshot: nextSnapshot,
  };
}

export function summarizeSnapshot(snapshot: LedgerSnapshot): string {
  const customers = snapshot.customers
    .map((customer) => `${customer.displayName}:${customer.id}`)
    .join(', ');
  const obligations = snapshot.obligations
    .map((obligation) => {
      const status = obligation.status === 'settled' ? 'settled' : 'open';
      return `${obligation.customerName} ${formatMinorUnits(
        obligation.originalAmountMinor,
        snapshot.currency,
      )} / ${formatMinorUnits(obligation.outstandingMinor, snapshot.currency)} ${status}`;
    })
    .join('; ');
  return `customers=[${customers}] obligations=[${obligations}]`;
}
