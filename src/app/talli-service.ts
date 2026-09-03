import { randomUUID } from 'node:crypto';
import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  applyLedgerAction,
  assertLedgerInvariants,
  projectLedger,
  summarizeSnapshot,
} from '../domain/ledger.js';
import { formatMinorUnits } from '../domain/money.js';
import type { ActionInterpreter } from '../interpreters.js';
import { AdvancedInterpreter, type AdvancedInterpreterInput } from '../interpreters.js';
import { compileLedgerIntent } from '../llm/intent-compiler.js';
import { createConfiguredStructuredActionModel } from '../llm/structured-action-model.js';
import { parseExplicitLedgerIntent } from './explicit-intent.js';
import {
  type PrepareLedgerMutationRequest,
  type ProposalAction,
  type ProposalCandidate,
  cloneLedgerDocument,
  computeLedgerFingerprint,
  formatProposalMoney,
  humanMoneyToMinorUnits,
  proposalCandidateSchema,
  summarizeMutationAction,
} from './ledger-mutations.js';
import type { TalliStorageBackend } from './storage-contract.js';
import { createConfiguredTalliStore } from './storage-factory.js';
import { MUTATION_PROPOSAL_TTL_MS } from './storage.js';
import type {
  ConversationTurnRecord,
  LedgerMutationOperation,
  LedgerMutationProposal,
  LedgerMutationProposalStatus,
  LoadedSession,
  PendingClarificationState,
  SessionState,
} from './storage.js';

export interface TalliMessageInput {
  text: string;
  sessionId?: string;
  referenceTime?: string;
  timezone?: string;
  language?: 'en' | 'pcm' | 'mixed';
  origin?: 'web' | 'telegram';
}

export interface TalliLedgerChange {
  customerId?: string;
  customerName?: string;
  obligationId?: string;
  amountMinor?: number;
  outstandingMinor?: number;
  originalAmountMinor?: number;
  status?: 'open' | 'settled';
}

export interface TalliClarificationResponse {
  question: string;
  candidates: Array<{
    kind: 'customer' | 'obligation';
    customerId?: string;
    obligationId?: string;
    displayName: string;
    aliases?: string[];
    outstandingMinor?: number;
    currency?: string;
    reason?: string;
  }>;
}

export interface TalliMessageResponse {
  status: 'applied' | 'clarification_required' | 'no_action' | 'error';
  message: string;
  action: {
    type: LedgerAction['type'];
    customerId?: string | null;
    customerName?: string | null;
    obligationId?: string | null;
    amountMinor?: number | null;
    correctedAmountMinor?: number | null;
    settleRemaining?: boolean;
    dueAt?: string | null;
  } | null;
  ledgerChange: TalliLedgerChange | null;
  clarification: TalliClarificationResponse | null;
  turnId: string;
  sessionId: string;
  errorCode: string | null;
  modelAvailable: boolean;
}

export interface LedgerMutationProposalView {
  proposalId: string;
  operation: LedgerMutationOperation;
  summary: string;
  status: LedgerMutationProposalStatus;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
}

export interface LedgerMutationConfirmationRequiredResponse {
  status: 'confirmation_required';
  proposal: LedgerMutationProposalView;
  message: string;
}

export interface LedgerMutationClarificationRequiredResponse {
  status: 'clarification_required';
  reasonCode:
    | 'AMBIGUOUS_CUSTOMER'
    | 'AMBIGUOUS_OBLIGATION'
    | 'UNKNOWN_CUSTOMER'
    | 'UNKNOWN_OBLIGATION'
    | 'INVALID_REQUEST';
  message: string;
  candidates: ProposalCandidate[];
}

export interface LedgerMutationRejectedResponse {
  status: 'rejected';
  reasonCode: string;
  message: string;
}

export type LedgerMutationPrepareResponse =
  | LedgerMutationConfirmationRequiredResponse
  | LedgerMutationClarificationRequiredResponse
  | LedgerMutationRejectedResponse;

export interface LedgerMutationCurrentResponse {
  status: 'pending' | 'none';
  proposal: LedgerMutationProposalView | null;
}

export interface LedgerMutationConfirmationResponse {
  status:
    | 'confirmed'
    | 'already_confirmed'
    | 'cancelled'
    | 'already_cancelled'
    | 'expired'
    | 'stale'
    | 'rejected';
  reasonCode?: string;
  message: string;
  proposal: LedgerMutationProposalView | null;
}

export interface TalliServiceOptions {
  interpreter?: ActionInterpreter | null;
  store?: TalliStorageBackend;
  defaultSessionId?: string;
  telegramNotifier?: TelegramConfirmationTransport | null;
}

export interface TelegramConfirmationTransport {
  sendMessage(chatId: number, text: string): Promise<void>;
}

const SAFE_PROVIDER_FAILURE_MESSAGE =
  "I couldn't interpret that safely just now. Nothing was changed. Please try again.";

function formatMoney(minorUnits: number, currency: string): string {
  return formatMinorUnits(minorUnits, currency);
}

function detectLanguage(text: string): 'en' | 'pcm' | 'mixed' {
  if (/\b(don|wey|na|carry|dey|dem|im|una|fit|oo|eh|sha)\b/i.test(text)) {
    return 'pcm';
  }
  return 'en';
}

function formatWeekdayLabel(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(new Date(date));
}

function formatDateLabel(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(date));
}

function formatDuePhrase(dueAt: string | null | undefined, timezone: string): string | null {
  if (!dueAt) {
    return null;
  }
  const weekday = formatWeekdayLabel(dueAt, timezone);
  const dateLabel = formatDateLabel(dueAt, timezone);
  return `${weekday} (${dateLabel})`;
}

function summarizeAction(action: LedgerAction): TalliMessageResponse['action'] {
  switch (action.type) {
    case 'CREATE_OBLIGATION':
      return {
        type: action.type,
        customerName:
          action.customer.kind === 'new' || action.customer.kind === 'name'
            ? action.customer.name
            : action.customer.kind === 'id'
              ? action.customer.customerId
              : null,
        amountMinor: action.amountMinor,
        dueAt: action.dueAt ?? null,
      };
    case 'RECORD_PAYMENT':
      return {
        type: action.type,
        customerId: action.customer?.kind === 'id' ? action.customer.customerId : null,
        obligationId: action.obligation?.kind === 'id' ? action.obligation.obligationId : null,
        amountMinor: action.amountMinor ?? null,
        settleRemaining: action.settleRemaining,
      };
    case 'SETTLE_OBLIGATION':
      return {
        type: action.type,
        obligationId: action.obligation.kind === 'id' ? action.obligation.obligationId : null,
        amountMinor: action.amountMinor ?? null,
      };
    case 'CORRECT_OBLIGATION':
      return {
        type: action.type,
        obligationId: action.obligation.kind === 'id' ? action.obligation.obligationId : null,
        correctedAmountMinor: action.correctedAmountMinor,
      };
    case 'REQUEST_CLARIFICATION':
      return { type: action.type };
    case 'NO_ACTION':
      return { type: action.type };
    default: {
      const never: never = action;
      return never;
    }
  }
}

function formatClarification(
  action: Extract<LedgerAction, { type: 'REQUEST_CLARIFICATION' }>,
  snapshot: LedgerSnapshot,
): TalliClarificationResponse {
  const candidates: TalliClarificationResponse['candidates'] = [];

  for (const customerId of action.candidateCustomerIds) {
    const customer = snapshot.customers.find((entry) => entry.id === customerId);
    if (!customer) {
      continue;
    }
    candidates.push({
      kind: 'customer',
      customerId: customer.id,
      displayName: customer.displayName,
      aliases: customer.aliases.slice(0, 2),
      outstandingMinor: snapshot.obligations
        .filter((obligation) => obligation.customerId === customer.id)
        .reduce((sum, obligation) => sum + obligation.outstandingMinor, 0),
      currency: snapshot.currency,
    });
  }

  for (const obligationId of action.candidateObligationIds) {
    const obligation = snapshot.obligations.find((entry) => entry.id === obligationId);
    if (!obligation) {
      continue;
    }
    candidates.push({
      kind: 'obligation',
      obligationId: obligation.id,
      displayName: `${obligation.customerName} ${formatMoney(
        obligation.outstandingMinor,
        snapshot.currency,
      )} remaining`,
      outstandingMinor: obligation.outstandingMinor,
      currency: snapshot.currency,
    });
  }

  return {
    question: action.question,
    candidates,
  };
}

function toPendingClarification(
  turnId: string,
  action: Extract<LedgerAction, { type: 'REQUEST_CLARIFICATION' }>,
  sourceText: string,
): PendingClarificationState {
  return {
    turnId,
    question: action.question,
    ambiguityKind: action.ambiguityKind,
    candidateCustomerIds: [...action.candidateCustomerIds],
    candidateObligationIds: [...action.candidateObligationIds],
    sourceText,
    createdAt: new Date().toISOString(),
  };
}

function classifyProviderFailure(diagnostics: unknown): string {
  const typed = diagnostics as {
    rateLimitFailures?: number;
    schemaInvalidResponses?: number;
    failureReason?: string;
    providerFailures?: number;
    rawOutputs?: string[];
  };

  if ((typed.rateLimitFailures ?? 0) > 0) {
    return 'RATE_LIMITED';
  }

  if ((typed.schemaInvalidResponses ?? 0) > 0) {
    return 'INVALID_MODEL_OUTPUT';
  }

  const failureText = [typed.failureReason, ...(typed.rawOutputs ?? [])].filter(Boolean).join(' ');
  if (/fetch failed|HTTP 000|network|ECONN|ENOTFOUND|timeout/i.test(failureText)) {
    return 'PROVIDER_UNAVAILABLE';
  }

  if ((typed.providerFailures ?? 0) > 0) {
    return 'PROVIDER_ERROR';
  }

  return 'PROVIDER_ERROR';
}

function summarizeCustomerChange(
  snapshot: LedgerSnapshot,
  action: LedgerAction,
  resultSnapshot: LedgerSnapshot,
): TalliLedgerChange | null {
  switch (action.type) {
    case 'CREATE_OBLIGATION': {
      const obligation = resultSnapshot.obligations.at(-1);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: obligation.originalAmountMinor,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'RECORD_PAYMENT': {
      const obligationId = action.obligation?.kind === 'id' ? action.obligation.obligationId : null;
      const obligation = resultSnapshot.obligations.find((entry) => entry.id === obligationId);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: action.amountMinor ?? undefined,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'SETTLE_OBLIGATION': {
      const obligationId = action.obligation.kind === 'id' ? action.obligation.obligationId : null;
      const obligation = resultSnapshot.obligations.find((entry) => entry.id === obligationId);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: obligation.originalAmountMinor,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'CORRECT_OBLIGATION': {
      const obligationId = action.obligation.kind === 'id' ? action.obligation.obligationId : null;
      const obligation = resultSnapshot.obligations.find((entry) => entry.id === obligationId);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: action.correctedAmountMinor,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'REQUEST_CLARIFICATION':
    case 'NO_ACTION':
      return null;
    default: {
      const never: never = action;
      void never;
      return null;
    }
  }
}

function clarificationMessage(
  action: Extract<LedgerAction, { type: 'REQUEST_CLARIFICATION' }>,
  snapshot: LedgerSnapshot,
): string {
  const names = [
    ...action.candidateCustomerIds.map((customerId) => {
      const customer = snapshot.customers.find((entry) => entry.id === customerId);
      return customer?.displayName ?? customerId;
    }),
    ...action.candidateObligationIds.map((obligationId) => {
      const obligation = snapshot.obligations.find((entry) => entry.id === obligationId);
      return obligation
        ? `${obligation.customerName} (${formatMoney(
            obligation.outstandingMinor,
            snapshot.currency,
          )} remaining)`
        : obligationId;
    }),
  ].filter(Boolean);

  if (names.length === 0) {
    return action.question;
  }

  return `${action.question} Candidates: ${names.join(', ')}.`;
}

function noActionMessage(action: Extract<LedgerAction, { type: 'NO_ACTION' }>): string {
  return action.reason ?? 'No ledger change was made.';
}

function buildProposalView(proposal: LedgerMutationProposal): LedgerMutationProposalView {
  return {
    proposalId: proposal.proposalId,
    operation: proposal.operation,
    summary: proposal.summary,
    status: proposal.status,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    confirmedAt: proposal.confirmedAt,
    cancelledAt: proposal.cancelledAt,
  };
}

function isProposalExpired(proposal: LedgerMutationProposal, now = Date.now()): boolean {
  return new Date(proposal.expiresAt).getTime() <= now;
}

function isProposalFingerprintStale(
  proposal: LedgerMutationProposal,
  snapshot: LedgerSnapshot,
  revision: number,
): boolean {
  return (
    proposal.ledgerRevision !== revision ||
    proposal.ledgerFingerprint !== computeLedgerFingerprint(snapshot)
  );
}

function buildClarificationCandidates(
  clarification: NonNullable<ReturnType<typeof applyLedgerAction>['clarification']>,
  snapshot: LedgerSnapshot,
): ProposalCandidate[] {
  const candidates: ProposalCandidate[] = [];

  for (const customerId of clarification.candidateCustomerIds) {
    const customer = snapshot.customers.find((entry) => entry.id === customerId);
    if (!customer) {
      continue;
    }
    candidates.push(
      proposalCandidateSchema.parse({
        kind: 'customer',
        customerId: customer.id,
        displayName: customer.displayName,
        aliases: customer.aliases.slice(0, 2),
        outstandingMinor: snapshot.obligations
          .filter((obligation) => obligation.customerId === customer.id)
          .reduce((sum, obligation) => sum + obligation.outstandingMinor, 0),
        currency: snapshot.currency,
      }),
    );
  }

  for (const obligationId of clarification.candidateObligationIds) {
    const obligation = snapshot.obligations.find((entry) => entry.id === obligationId);
    if (!obligation) {
      continue;
    }
    candidates.push(
      proposalCandidateSchema.parse({
        kind: 'obligation',
        obligationId: obligation.id,
        displayName: `${obligation.customerName} ${formatProposalMoney(
          obligation.outstandingMinor,
          snapshot.currency,
        )} remaining`,
        outstandingMinor: obligation.outstandingMinor,
        currency: snapshot.currency,
      }),
    );
  }

  return candidates;
}

function classifyClarification(
  clarification: NonNullable<ReturnType<typeof applyLedgerAction>['clarification']>,
  reason?: string,
): {
  status: 'clarification_required' | 'rejected';
  reasonCode:
    | 'AMBIGUOUS_CUSTOMER'
    | 'AMBIGUOUS_OBLIGATION'
    | 'UNKNOWN_CUSTOMER'
    | 'UNKNOWN_OBLIGATION'
    | 'INVALID_REQUEST';
} {
  const hint = `${reason ?? ''} ${clarification.question}`.toLowerCase();

  if (clarification.candidateCustomerIds.length > 0) {
    return {
      status: 'clarification_required',
      reasonCode: 'AMBIGUOUS_CUSTOMER',
    };
  }

  if (clarification.candidateObligationIds.length > 0) {
    return {
      status: 'clarification_required',
      reasonCode: 'AMBIGUOUS_OBLIGATION',
    };
  }

  if (hint.includes('customer')) {
    return {
      status: 'rejected',
      reasonCode: 'UNKNOWN_CUSTOMER',
    };
  }

  if (hint.includes('obligation') || hint.includes('debt') || hint.includes('payment')) {
    return {
      status: 'rejected',
      reasonCode: 'UNKNOWN_OBLIGATION',
    };
  }

  return {
    status: 'rejected',
    reasonCode: 'INVALID_REQUEST',
  };
}

function findResultObligation(
  action: LedgerAction,
  snapshotAfter: LedgerSnapshot,
  result: ReturnType<typeof applyLedgerAction>,
): (typeof snapshotAfter.obligations)[number] | undefined {
  if (result.event && 'obligationId' in result.event) {
    const obligationId = result.event.obligationId;
    return snapshotAfter.obligations.find((entry) => entry.id === obligationId);
  }

  if (action.type === 'CREATE_OBLIGATION') {
    return snapshotAfter.obligations.at(-1);
  }

  return undefined;
}

export class TalliService {
  readonly store: TalliStorageBackend;
  readonly interpreter: ActionInterpreter | null;
  private readonly telegramNotifier: TelegramConfirmationTransport | null;
  private readonly sessionMutationQueues = new Map<string, Promise<void>>();

  constructor(options: TalliServiceOptions = {}) {
    this.store =
      options.store ?? createConfiguredTalliStore({ defaultSessionId: options.defaultSessionId });
    this.interpreter =
      options.interpreter !== undefined ? options.interpreter : this.createDefaultInterpreter();
    this.telegramNotifier = options.telegramNotifier ?? null;
  }

  private createDefaultInterpreter(): ActionInterpreter | null {
    const model = createConfiguredStructuredActionModel();
    if (!model) {
      return null;
    }
    return new AdvancedInterpreter(model);
  }

  private async withSessionMutationLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.sessionMutationQueues.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.sessionMutationQueues.get(sessionId) === tail) {
        this.sessionMutationQueues.delete(sessionId);
      }
    }
  }

  async loadSession(sessionId?: string): Promise<LoadedSession> {
    return this.store.load(sessionId);
  }

  async getCurrentUser(sessionId?: string) {
    const activeSessionId = sessionId ?? this.store.defaultSessionId;
    const [identity, loaded] = await Promise.all([
      this.store.getUserIdentity(activeSessionId),
      this.store.load(activeSessionId),
    ]);
    return {
      userId: loaded.state.userId ?? activeSessionId,
      sessionId: activeSessionId,
      telegramUserId: identity.telegramUserId,
      telegramUsername: identity.telegramUsername,
      preferredCurrency: loaded.state.preferredCurrency ?? loaded.state.ledgerCurrency,
      ledgerCurrency: loaded.document.currency,
      connected: identity.telegramUserId !== null,
    };
  }

  async createTelegramLinkToken(sessionId?: string, ttlMs?: number) {
    return this.store.createTelegramLinkToken({
      sessionId,
      ttlMs,
    });
  }

  async consumeTelegramLinkToken(input: {
    token: string;
    telegramUserId: string;
    telegramUsername?: string | null;
  }) {
    return this.store.consumeTelegramLinkToken(input);
  }

  async getTelegramLinkToken(token: string) {
    return this.store.getTelegramLinkToken(token);
  }

  async disconnectTelegram(sessionId: string): Promise<void> {
    await this.store.disconnectTelegram(sessionId);
  }

  async setPreferredCurrency(sessionId: string, currency: string): Promise<void> {
    await this.store.setPreferredCurrency(sessionId, currency);
  }

  async prepareLedgerMutation(
    sessionId: string,
    input: PrepareLedgerMutationRequest,
  ): Promise<LedgerMutationPrepareResponse> {
    return this.withSessionMutationLock(sessionId, async () => {
      const loaded = await this.store.load(sessionId);
      const snapshot = projectLedger(loaded.document);

      let action: ProposalAction;
      try {
        action = this.buildLedgerMutationAction(input, snapshot);
      } catch (error) {
        return {
          status: 'rejected',
          reasonCode: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid mutation request.',
        };
      }

      const dryRun = applyLedgerAction(cloneLedgerDocument(loaded.document), action, {
        now: new Date(),
        actor: 'system',
        turnId: randomUUID(),
        sourceText: 'prepare_ledger_mutation',
      });

      assertLedgerInvariants(dryRun.snapshot);

      if (dryRun.clarification) {
        const classification = classifyClarification(dryRun.clarification, dryRun.reason);
        if (classification.status === 'clarification_required') {
          return {
            status: 'clarification_required',
            reasonCode: classification.reasonCode,
            message: dryRun.clarification.question,
            candidates: buildClarificationCandidates(dryRun.clarification, snapshot),
          };
        }

        return {
          status: 'rejected',
          reasonCode: classification.reasonCode,
          message: dryRun.reason ?? dryRun.clarification.question,
        };
      }

      if (!dryRun.applied) {
        return {
          status: 'rejected',
          reasonCode: 'INVALID_REQUEST',
          message: dryRun.reason ?? 'Unable to prepare that mutation safely.',
        };
      }

      const proposalId = randomUUID();
      const createdAt = new Date().toISOString();
      const proposal: LedgerMutationProposal = {
        proposalId,
        sessionId,
        operation: action.type,
        action,
        summary: summarizeMutationAction(action, dryRun.snapshot),
        status: 'pending',
        createdAt,
        expiresAt: new Date(Date.now() + MUTATION_PROPOSAL_TTL_MS).toISOString(),
        confirmedAt: null,
        cancelledAt: null,
        ledgerRevision: loaded.document.events.length,
        ledgerFingerprint: computeLedgerFingerprint(snapshot),
      };

      const nextState: SessionState = {
        ...loaded.state,
        ledgerMutationProposal: proposal,
        updatedAt: createdAt,
      };

      await this.store.saveState(loaded.statePath, nextState);

      return {
        status: 'confirmation_required',
        proposal: buildProposalView(proposal),
        message: `Review this proposal before confirming: ${proposal.summary}`,
      };
    });
  }

  async getPendingLedgerMutation(sessionId: string): Promise<LedgerMutationProposalView | null> {
    const loaded = await this.store.load(sessionId);
    const proposal = loaded.state.ledgerMutationProposal;
    if (!proposal || proposal.sessionId !== sessionId || proposal.status !== 'pending') {
      return null;
    }

    if (isProposalExpired(proposal)) {
      return null;
    }

    const snapshot = projectLedger(loaded.document);
    if (isProposalFingerprintStale(proposal, snapshot, loaded.document.events.length)) {
      return null;
    }

    return buildProposalView(proposal);
  }

  async confirmLedgerMutation(
    sessionId: string,
    proposalId: string,
  ): Promise<LedgerMutationConfirmationResponse> {
    return this.withSessionMutationLock(sessionId, async () => {
      const loaded = await this.store.load(sessionId);
      const proposal = loaded.state.ledgerMutationProposal;
      if (!proposal || proposal.sessionId !== sessionId || proposal.proposalId !== proposalId) {
        return {
          status: 'rejected',
          reasonCode: 'PROPOSAL_NOT_FOUND',
          message: 'No matching proposal exists for this session.',
          proposal: null,
        };
      }

      const proposalView = buildProposalView(proposal);
      if (proposal.status === 'confirmed') {
        return {
          status: 'already_confirmed',
          message: 'This proposal was already confirmed.',
          proposal: proposalView,
        };
      }
      if (proposal.status === 'cancelled') {
        return {
          status: 'cancelled',
          message: 'This proposal was cancelled before confirmation.',
          proposal: proposalView,
        };
      }
      if (proposal.status === 'expired') {
        return {
          status: 'expired',
          message: 'This proposal expired before it could be confirmed.',
          proposal: proposalView,
        };
      }
      if (proposal.status === 'stale') {
        return {
          status: 'stale',
          message: 'The ledger changed after this proposal was prepared.',
          proposal: proposalView,
        };
      }

      if (isProposalExpired(proposal)) {
        const nextState: SessionState = {
          ...loaded.state,
          ledgerMutationProposal: {
            ...proposal,
            status: 'expired',
          },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveState(loaded.statePath, nextState);
        return {
          status: 'expired',
          message: 'This proposal expired before it could be confirmed.',
          proposal: buildProposalView({
            ...proposal,
            status: 'expired',
          }),
        };
      }

      if (loaded.document.events.some((event) => event.turnId === proposalId)) {
        const nextState: SessionState = {
          ...loaded.state,
          ledgerMutationProposal: {
            ...proposal,
            status: 'confirmed',
            confirmedAt: proposal.confirmedAt ?? new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveState(loaded.statePath, nextState);
        return {
          status: 'already_confirmed',
          message: 'This proposal was already confirmed.',
          proposal: buildProposalView({
            ...proposal,
            status: 'confirmed',
            confirmedAt: proposal.confirmedAt ?? new Date().toISOString(),
          }),
        };
      }

      const snapshot = projectLedger(loaded.document);
      if (isProposalFingerprintStale(proposal, snapshot, loaded.document.events.length)) {
        const nextState: SessionState = {
          ...loaded.state,
          ledgerMutationProposal: {
            ...proposal,
            status: 'stale',
          },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveState(loaded.statePath, nextState);
        return {
          status: 'stale',
          message: 'The ledger changed after this proposal was prepared.',
          proposal: buildProposalView({
            ...proposal,
            status: 'stale',
          }),
        };
      }

      const result = applyLedgerAction(cloneLedgerDocument(loaded.document), proposal.action, {
        now: new Date(),
        actor: 'system',
        turnId: proposalId,
        sourceText: 'proposal_confirmation',
      });

      assertLedgerInvariants(result.snapshot);

      const confirmedAt = new Date().toISOString();
      const nextState: SessionState = {
        ...loaded.state,
        ledgerCurrency: result.snapshot.currency,
        preferredCurrency: result.snapshot.currency,
        ledgerMutationProposal: {
          ...proposal,
          status: 'confirmed',
          confirmedAt,
        },
        updatedAt: confirmedAt,
      };

      await this.store.save({
        document: result.document,
        state: nextState,
        ledgerPath: loaded.ledgerPath,
        statePath: loaded.statePath,
      });

      return {
        status: 'confirmed',
        message: `Confirmed: ${proposal.summary}`,
        proposal: buildProposalView({
          ...proposal,
          status: 'confirmed',
          confirmedAt,
        }),
      };
    });
  }

  async cancelLedgerMutation(
    sessionId: string,
    proposalId: string,
  ): Promise<LedgerMutationConfirmationResponse> {
    return this.withSessionMutationLock(sessionId, async () => {
      const loaded = await this.store.load(sessionId);
      const proposal = loaded.state.ledgerMutationProposal;
      if (!proposal || proposal.sessionId !== sessionId || proposal.proposalId !== proposalId) {
        return {
          status: 'rejected',
          reasonCode: 'PROPOSAL_NOT_FOUND',
          message: 'No matching proposal exists for this session.',
          proposal: null,
        };
      }

      const proposalView = buildProposalView(proposal);
      if (proposal.status === 'confirmed') {
        return {
          status: 'already_confirmed',
          message: 'This proposal was already confirmed and cannot be cancelled.',
          proposal: proposalView,
        };
      }
      if (proposal.status === 'cancelled') {
        return {
          status: 'already_cancelled',
          message: 'This proposal was already cancelled.',
          proposal: proposalView,
        };
      }
      if (proposal.status === 'expired') {
        return {
          status: 'expired',
          message: 'This proposal expired before cancellation.',
          proposal: proposalView,
        };
      }
      if (proposal.status === 'stale') {
        return {
          status: 'stale',
          message: 'This proposal became stale before cancellation.',
          proposal: proposalView,
        };
      }

      const snapshot = projectLedger(loaded.document);
      if (isProposalExpired(proposal)) {
        const nextState: SessionState = {
          ...loaded.state,
          ledgerMutationProposal: {
            ...proposal,
            status: 'expired',
          },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveState(loaded.statePath, nextState);
        return {
          status: 'expired',
          message: 'This proposal expired before cancellation.',
          proposal: buildProposalView({
            ...proposal,
            status: 'expired',
          }),
        };
      }

      if (isProposalFingerprintStale(proposal, snapshot, loaded.document.events.length)) {
        const nextState: SessionState = {
          ...loaded.state,
          ledgerMutationProposal: {
            ...proposal,
            status: 'stale',
          },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveState(loaded.statePath, nextState);
        return {
          status: 'stale',
          message: 'This proposal became stale before cancellation.',
          proposal: buildProposalView({
            ...proposal,
            status: 'stale',
          }),
        };
      }

      const cancelledAt = new Date().toISOString();
      const nextState: SessionState = {
        ...loaded.state,
        ledgerMutationProposal: {
          ...proposal,
          status: 'cancelled',
          cancelledAt,
        },
        updatedAt: cancelledAt,
      };

      await this.store.saveState(loaded.statePath, nextState);

      return {
        status: 'cancelled',
        message: 'Proposal cancelled.',
        proposal: buildProposalView({
          ...proposal,
          status: 'cancelled',
          cancelledAt,
        }),
      };
    });
  }

  private buildLedgerMutationAction(
    input: PrepareLedgerMutationRequest,
    snapshot: LedgerSnapshot,
  ): ProposalAction {
    const requestedCurrency =
      'amount' in input && input.amount ? input.amount.currency.toUpperCase() : snapshot.currency;

    if (requestedCurrency !== snapshot.currency.toUpperCase()) {
      throw new Error(
        `This ledger is using ${snapshot.currency}, but the request used ${requestedCurrency}.`,
      );
    }

    switch (input.operation) {
      case 'CREATE_OBLIGATION': {
        if (input.customer.kind === 'name' && input.customer.allowCreate) {
          throw new Error('New customers must use customer.kind = "new".');
        }

        return ledgerActionSchema.parse({
          type: 'CREATE_OBLIGATION',
          customer: input.customer,
          amountMinor: humanMoneyToMinorUnits(input.amount),
          dueAt: input.dueAt ?? undefined,
          permittedMutation: true,
          evidence: [],
        }) as ProposalAction;
      }
      case 'RECORD_PAYMENT': {
        const customer = 'customer' in input ? input.customer : undefined;
        if (input.settleRemaining && input.amount) {
          throw new Error('Record payment requests must omit amount when settleRemaining is true.');
        }

        if (customer?.kind === 'name' && customer.allowCreate) {
          throw new Error('Payment requests must resolve to an existing customer.');
        }

        return ledgerActionSchema.parse({
          type: 'RECORD_PAYMENT',
          customer,
          obligation: input.obligation,
          amountMinor: input.amount ? humanMoneyToMinorUnits(input.amount) : undefined,
          settleRemaining: input.settleRemaining,
          permittedMutation: true,
          evidence: [],
        }) as ProposalAction;
      }
      case 'SETTLE_OBLIGATION': {
        return ledgerActionSchema.parse({
          type: 'SETTLE_OBLIGATION',
          obligation: input.obligation,
          amountMinor: input.amount ? humanMoneyToMinorUnits(input.amount) : undefined,
          permittedMutation: true,
          evidence: [],
        }) as ProposalAction;
      }
      default: {
        throw new Error('Unsupported proposal operation.');
      }
    }
  }

  async getLedger(sessionId?: string): Promise<LedgerSnapshot> {
    const session = await this.store.load(sessionId);
    return projectLedger(session.document);
  }

  async getCustomer(customerId: string, sessionId?: string) {
    const snapshot = await this.getLedger(sessionId);
    const customer = snapshot.customers.find((entry) => entry.id === customerId) ?? null;
    const obligations = snapshot.obligations.filter((entry) => entry.customerId === customerId);
    return { customer, obligations };
  }

  async getCustomerHistory(customerId: string, sessionId?: string) {
    const session = await this.store.load(sessionId);
    const snapshot = projectLedger(session.document);
    return {
      customer: snapshot.customers.find((entry) => entry.id === customerId) ?? null,
      obligations: snapshot.obligations.filter((entry) => entry.customerId === customerId),
      events: session.document.events.filter((event) => {
        if ('customerId' in event) {
          return event.customerId === customerId;
        }
        return false;
      }),
      recentTurns: session.state.recentTurns.filter((turn) => {
        return turn.customerId === customerId || turn.obligationId !== null;
      }),
    };
  }

  async resetDemoLedger(sessionId?: string): Promise<void> {
    await this.store.reset(sessionId);
  }

  async seedDemoLedger(sessionId?: string): Promise<void> {
    const { buildDemoSeed } = await import('./demo-data.js');
    const seed = buildDemoSeed();
    await this.store.seed(seed, sessionId);
  }

  async processMessage(input: TalliMessageInput): Promise<TalliMessageResponse> {
    const sessionId = input.sessionId ?? this.store.defaultSessionId;
    const turnId = randomUUID();
    const referenceTime = input.referenceTime ?? new Date().toISOString();
    const timezone = input.timezone ?? this.store.timezone;
    const language = input.language ?? detectLanguage(input.text);
    const origin = input.origin ?? 'web';
    const loaded = await this.store.load(sessionId);
    let workingDocument = loaded.document;
    let snapshotBefore = projectLedger(workingDocument);
    const currentTurns = loaded.state.recentTurns.slice(-8).map((turn) => ({
      turnId: turn.turnId,
      text: turn.inputText,
    }));
    const pendingClarification = loaded.state.pendingClarification;

    const directParse = parseExplicitLedgerIntent({
      text: input.text,
      snapshot: snapshotBefore,
    });

    if (
      directParse?.explicitCurrency &&
      workingDocument.currency !== directParse.explicitCurrency
    ) {
      const isEmptyLedger =
        snapshotBefore.customers.length === 0 &&
        snapshotBefore.obligations.length === 0 &&
        workingDocument.events.length === 0;
      if (isEmptyLedger) {
        workingDocument = {
          ...workingDocument,
          currency: directParse.explicitCurrency,
        };
        snapshotBefore = projectLedger(workingDocument);
      } else {
        const question = `This ledger is currently using ${workingDocument.currency}, but your update says ${directParse.explicitCurrency}. Switch the ledger currency first.`;
        const response: TalliMessageResponse = {
          status: 'clarification_required',
          message: question,
          action: ledgerActionSchema.parse({
            type: 'REQUEST_CLARIFICATION',
            question,
            ambiguityKind: 'other',
            candidateCustomerIds: [],
            candidateObligationIds: [],
            permittedMutation: false,
            evidence: [],
          }),
          ledgerChange: null,
          clarification: {
            question,
            candidates: [],
          },
          turnId,
          sessionId,
          errorCode: null,
          modelAvailable: Boolean(this.interpreter),
        };
        await this.recordTurn({
          loaded,
          sessionId,
          turnId,
          input,
          language,
          status: 'clarification_required',
          message: response.message,
          errorCode: response.errorCode,
          actionType: 'REQUEST_CLARIFICATION',
          customerId: null,
          obligationId: null,
          amountMinor: null,
          outstandingMinor: null,
          clarification: {
            question,
            ambiguityKind: 'other',
            candidateCustomerIds: [],
            candidateObligationIds: [],
          },
          pendingClarification: loaded.state.pendingClarification,
        });
        await this.maybeSendTelegramConfirmation(sessionId, origin, response);
        return response;
      }
    }

    if (directParse) {
      const adoptedExplicitCurrency =
        directParse.explicitCurrency !== undefined &&
        workingDocument.currency !== directParse.explicitCurrency &&
        snapshotBefore.customers.length === 0 &&
        snapshotBefore.obligations.length === 0 &&
        workingDocument.events.length === 0;
      const compiled = compileLedgerIntent({
        intent: directParse.intent,
        utterance: input.text,
        language,
        clock: {
          referenceNow: referenceTime,
          timezone,
        },
        snapshot: snapshotBefore,
        document: workingDocument,
      });
      const parsedAction = compiled.action;
      const result = applyLedgerAction(workingDocument, parsedAction, {
        now: new Date(referenceTime),
        actor: 'system',
        turnId,
        sourceText: input.text,
      });
      assertLedgerInvariants(result.snapshot);

      const nextState = this.updateSessionState(loaded.state, {
        turnId,
        input,
        language,
        responseAction: parsedAction,
        result,
        sessionId,
      });
      if (adoptedExplicitCurrency && directParse.explicitCurrency) {
        nextState.preferredCurrency = directParse.explicitCurrency;
      }

      const appendedEvents = result.document.events.slice(workingDocument.events.length);
      await this.store.appendEvents(loaded.ledgerPath, appendedEvents);
      await this.store.saveState(loaded.statePath, nextState);

      const response = this.buildResponse({
        sessionId,
        turnId,
        input,
        language,
        action: parsedAction,
        result,
        snapshotBefore,
        snapshotAfter: result.snapshot,
      });
      await this.maybeSendTelegramConfirmation(sessionId, origin, response);
      return response;
    }

    if (!this.interpreter) {
      const response = this.buildErrorResponse({
        sessionId,
        turnId,
        message: SAFE_PROVIDER_FAILURE_MESSAGE,
        errorCode: 'PROVIDER_UNAVAILABLE',
      });
      await this.recordTurn({
        loaded,
        sessionId,
        turnId,
        input,
        language,
        status: 'error',
        message: response.message,
        errorCode: response.errorCode,
        actionType: null,
        customerId: null,
        obligationId: null,
        amountMinor: null,
        outstandingMinor: null,
        clarification: null,
        pendingClarification: null,
      });
      return response;
    }

    const interpreterInput: AdvancedInterpreterInput = {
      text: input.text,
      language,
      benchmark: {
        scenarioId: `runtime-${sessionId}`,
        turnId,
        referenceNow: referenceTime,
        timezone,
      },
      snapshot: snapshotBefore,
      document: workingDocument,
      recentTurns: currentTurns,
      pendingClarification,
    };

    let action: LedgerAction;
    try {
      action = await this.interpreter.interpret(interpreterInput);
    } catch (error) {
      const response = this.buildErrorResponse({
        sessionId,
        turnId,
        message: SAFE_PROVIDER_FAILURE_MESSAGE,
        errorCode: 'PROVIDER_UNAVAILABLE',
      });
      await this.recordTurn({
        loaded,
        sessionId,
        turnId,
        input,
        language,
        status: 'error',
        message: response.message,
        errorCode: response.errorCode,
        actionType: null,
        customerId: null,
        obligationId: null,
        amountMinor: null,
        outstandingMinor: null,
        clarification: null,
        pendingClarification: null,
      });
      void error;
      return response;
    }

    const providerDiagnostics = this.interpreter.lastDiagnostics?.provider ?? null;
    const providerFailure = this.interpreter.lastDiagnostics?.providerFailure;
    if (providerFailure || !providerDiagnostics) {
      const errorCode = classifyProviderFailure(providerDiagnostics ?? {});
      const response = this.buildErrorResponse({
        sessionId,
        turnId,
        message: SAFE_PROVIDER_FAILURE_MESSAGE,
        errorCode,
      });
      await this.recordTurn({
        loaded,
        sessionId,
        turnId,
        input,
        language,
        status: 'error',
        message: response.message,
        errorCode: response.errorCode,
        actionType: null,
        customerId: null,
        obligationId: null,
        amountMinor: null,
        outstandingMinor: null,
        clarification: null,
        pendingClarification: loaded.state.pendingClarification,
      });
      return response;
    }

    const parsedAction = ledgerActionSchema.parse(action);
    const result = applyLedgerAction(workingDocument, parsedAction, {
      now: new Date(referenceTime),
      actor: 'system',
      turnId,
      sourceText: input.text,
    });
    assertLedgerInvariants(result.snapshot);

    const nextState = this.updateSessionState(loaded.state, {
      turnId,
      input,
      language,
      responseAction: parsedAction,
      result,
      sessionId,
    });

    const appendedEvents = result.document.events.slice(workingDocument.events.length);
    await this.store.appendEvents(loaded.ledgerPath, appendedEvents);
    await this.store.saveState(loaded.statePath, nextState);

    const response = this.buildResponse({
      sessionId,
      turnId,
      input,
      language,
      action: parsedAction,
      result,
      snapshotBefore,
      snapshotAfter: result.snapshot,
    });

    await this.maybeSendTelegramConfirmation(sessionId, origin, response);
    return response;
  }

  private async maybeSendTelegramConfirmation(
    sessionId: string,
    origin: 'web' | 'telegram',
    response: TalliMessageResponse,
  ): Promise<void> {
    if (origin === 'telegram' || !this.telegramNotifier) {
      return;
    }

    if (response.status !== 'applied' && response.status !== 'clarification_required') {
      return;
    }

    const identity = await this.store.getUserIdentity(sessionId);
    if (!identity.telegramUserId) {
      return;
    }

    const chatId = Number(identity.telegramUserId);
    if (!Number.isFinite(chatId)) {
      return;
    }

    try {
      await this.telegramNotifier.sendMessage(chatId, response.message);
    } catch (error) {
      console.error(error);
    }
  }

  private updateSessionState(
    state: SessionState,
    input: {
      turnId: string;
      input: TalliMessageInput;
      language: 'en' | 'pcm' | 'mixed';
      responseAction: LedgerAction;
      result: ReturnType<typeof applyLedgerAction>;
      sessionId: string;
    },
  ): SessionState {
    const clarification =
      input.responseAction.type === 'REQUEST_CLARIFICATION'
        ? toPendingClarification(input.turnId, input.responseAction, input.input.text)
        : null;

    const turnRecord: ConversationTurnRecord = {
      turnId: input.turnId,
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      inputText: input.input.text,
      language: input.language,
      status:
        input.responseAction.type === 'REQUEST_CLARIFICATION'
          ? 'clarification_required'
          : input.responseAction.type === 'NO_ACTION'
            ? 'no_action'
            : 'applied',
      actionType: input.responseAction.type,
      customerId: this.extractTurnCustomerId(input.result),
      obligationId: this.extractTurnObligationId(input.result),
      amountMinor: this.extractTurnAmountMinor(input.result),
      outstandingMinor: this.extractTurnOutstandingMinor(input.result),
      clarification:
        input.responseAction.type === 'REQUEST_CLARIFICATION'
          ? {
              question: input.responseAction.question,
              ambiguityKind: input.responseAction.ambiguityKind,
              candidateCustomerIds: [...input.responseAction.candidateCustomerIds],
              candidateObligationIds: [...input.responseAction.candidateObligationIds],
            }
          : null,
      message:
        input.responseAction.type === 'REQUEST_CLARIFICATION'
          ? input.responseAction.question
          : input.result.financialMutation
            ? 'Applied'
            : input.responseAction.type === 'NO_ACTION'
              ? (input.responseAction.reason ?? 'No action')
              : 'Applied',
      errorCode: null,
    };

    const recentTurns = [...state.recentTurns, turnRecord].slice(-this.store.turnHistoryLimit);
    return {
      ...state,
      ledgerCurrency: input.result.snapshot.currency,
      preferredCurrency: input.result.snapshot.currency,
      updatedAt: new Date().toISOString(),
      recentTurns,
      pendingClarification: clarification,
    };
  }

  private extractTurnCustomerId(result: ReturnType<typeof applyLedgerAction>): string | null {
    if (result.event && 'customerId' in result.event) {
      return result.event.customerId;
    }
    return null;
  }

  private extractTurnObligationId(result: ReturnType<typeof applyLedgerAction>): string | null {
    if (result.event && 'obligationId' in result.event) {
      return result.event.obligationId;
    }
    return null;
  }

  private extractTurnAmountMinor(result: ReturnType<typeof applyLedgerAction>): number | null {
    if (result.event && 'amountMinor' in result.event) {
      return result.event.amountMinor;
    }
    return null;
  }

  private extractTurnOutstandingMinor(result: ReturnType<typeof applyLedgerAction>): number | null {
    if (result.event) {
      if ('outstandingAfterMinor' in result.event) {
        return result.event.outstandingAfterMinor;
      }
      if ('correctedOutstandingMinor' in result.event) {
        return result.event.correctedOutstandingMinor;
      }
    }
    return result.snapshot.obligations.at(-1)?.outstandingMinor ?? null;
  }

  private async recordTurn(input: {
    loaded: LoadedSession;
    sessionId: string;
    turnId: string;
    input: TalliMessageInput;
    language: 'en' | 'pcm' | 'mixed';
    status: ConversationTurnRecord['status'];
    message: string;
    errorCode: string | null;
    actionType: string | null;
    customerId: string | null;
    obligationId: string | null;
    amountMinor: number | null;
    outstandingMinor: number | null;
    clarification: ConversationTurnRecord['clarification'];
    pendingClarification: PendingClarificationState | null;
  }): Promise<void> {
    const nextTurn: ConversationTurnRecord = {
      turnId: input.turnId,
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      inputText: input.input.text,
      language: input.language,
      status: input.status,
      actionType: input.actionType,
      customerId: input.customerId,
      obligationId: input.obligationId,
      amountMinor: input.amountMinor,
      outstandingMinor: input.outstandingMinor,
      clarification: input.clarification,
      message: input.message,
      errorCode: input.errorCode,
    };

    const nextState: SessionState = {
      ...input.loaded.state,
      ledgerCurrency: input.loaded.state.ledgerCurrency ?? input.loaded.document.currency,
      updatedAt: new Date().toISOString(),
      recentTurns: [...input.loaded.state.recentTurns, nextTurn].slice(
        -this.store.turnHistoryLimit,
      ),
      pendingClarification: input.pendingClarification,
    };

    await this.store.saveState(input.loaded.statePath, nextState);
  }

  private buildErrorResponse(input: {
    sessionId: string;
    turnId: string;
    message: string;
    errorCode: string;
  }): TalliMessageResponse {
    return {
      status: 'error',
      message: input.message,
      action: null,
      ledgerChange: null,
      clarification: null,
      turnId: input.turnId,
      sessionId: input.sessionId,
      errorCode: input.errorCode,
      modelAvailable: Boolean(this.interpreter),
    };
  }

  private buildResponse(input: {
    sessionId: string;
    turnId: string;
    input: TalliMessageInput;
    language: 'en' | 'pcm' | 'mixed';
    action: LedgerAction;
    result: ReturnType<typeof applyLedgerAction>;
    snapshotBefore: LedgerSnapshot;
    snapshotAfter: LedgerSnapshot;
  }): TalliMessageResponse {
    const action = input.action;
    const summaryAction = summarizeAction(action);

    switch (action.type) {
      case 'REQUEST_CLARIFICATION': {
        const clarification = formatClarification(action, input.snapshotAfter);
        return {
          status: 'clarification_required',
          message: clarificationMessage(action, input.snapshotAfter),
          action: summaryAction,
          ledgerChange: null,
          clarification,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'NO_ACTION':
        return {
          status: 'no_action',
          message: noActionMessage(action),
          action: summaryAction,
          ledgerChange: null,
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      case 'CREATE_OBLIGATION': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const duePhrase = formatDuePhrase(action.dueAt ?? null, this.store.timezone);
        const customerName =
          obligation?.customerName ??
          (action.customer.kind === 'new' || action.customer.kind === 'name'
            ? action.customer.name
            : action.customer.kind === 'id'
              ? action.customer.customerId
              : 'that customer');
        const message = duePhrase
          ? `${customerName} now owes ${formatMoney(
              obligation?.originalAmountMinor ?? action.amountMinor,
              input.snapshotAfter.currency,
            )}. Due ${duePhrase}.`
          : `${customerName} now owes ${formatMoney(
              obligation?.originalAmountMinor ?? action.amountMinor,
              input.snapshotAfter.currency,
            )}.`;
        return {
          status: 'applied',
          message,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: obligation.originalAmountMinor,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'RECORD_PAYMENT': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const paidAmount = action.amountMinor ?? 0;
        const remaining = obligation?.outstandingMinor ?? 0;
        const customerName = obligation?.customerName ?? 'That customer';
        const message =
          remaining === 0
            ? `Recorded ${formatMoney(
                paidAmount,
                input.snapshotAfter.currency,
              )} from ${customerName}. ${customerName}'s debt is fully settled.`
            : `Recorded ${formatMoney(
                paidAmount,
                input.snapshotAfter.currency,
              )} from ${customerName}. ${formatMoney(
                remaining,
                input.snapshotAfter.currency,
              )} remains.`;
        return {
          status: 'applied',
          message,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: paidAmount,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'SETTLE_OBLIGATION': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const customerName = obligation?.customerName ?? 'That customer';
        return {
          status: 'applied',
          message: `${customerName}'s debt is fully settled.`,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: obligation.originalAmountMinor,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'CORRECT_OBLIGATION': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const before = input.snapshotBefore.obligations.find((entry) => {
          if (input.result.event && 'obligationId' in input.result.event) {
            return entry.id === input.result.event.obligationId;
          }
          if (action.obligation.kind === 'id') {
            return entry.id === action.obligation.obligationId;
          }
          return false;
        });
        const customerName = obligation?.customerName ?? before?.customerName ?? 'That customer';
        const previous = before?.originalAmountMinor ?? action.correctedAmountMinor;
        const remaining = obligation?.outstandingMinor ?? 0;
        return {
          status: 'applied',
          message: `Updated ${customerName}'s original debt from ${formatMoney(
            previous,
            input.snapshotAfter.currency,
          )} to ${formatMoney(
            action.correctedAmountMinor,
            input.snapshotAfter.currency,
          )}. ${formatMoney(remaining, input.snapshotAfter.currency)} remains.`,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: action.correctedAmountMinor,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      default: {
        const never: never = action;
        void never;
        return {
          status: 'no_action',
          message: 'No ledger change was made.',
          action: summaryAction,
          ledgerChange: null,
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
    }
  }
}

export function createTalliService(options: TalliServiceOptions = {}): TalliService {
  return new TalliService(options);
}

export function summarizeLedger(snapshot: LedgerSnapshot): string {
  return summarizeSnapshot(snapshot);
}
