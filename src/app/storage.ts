import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LedgerAction } from '../domain/actions.js';
import { type LedgerDocument, type LedgerEvent, createLedgerDocument } from '../domain/ledger.js';

export const MUTATION_PROPOSAL_TTL_MS = 10 * 60 * 1000;

export type LedgerMutationProposalStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'stale';

export type LedgerMutationOperation = 'CREATE_OBLIGATION' | 'RECORD_PAYMENT' | 'SETTLE_OBLIGATION';

export interface LedgerMutationProposal {
  proposalId: string;
  sessionId: string;
  operation: LedgerMutationOperation;
  action: LedgerAction;
  summary: string;
  status: LedgerMutationProposalStatus;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  ledgerRevision: number;
  ledgerFingerprint: string;
}

export interface PendingClarificationState {
  turnId: string;
  question: string;
  ambiguityKind?: 'customer' | 'obligation' | 'amount' | 'correction' | 'other';
  candidateCustomerIds: string[];
  candidateObligationIds: string[];
  sourceText: string;
  createdAt: string;
}

export interface ConversationTurnRecord {
  turnId: string;
  timestamp: string;
  sessionId: string;
  inputText: string;
  language: 'en' | 'pcm' | 'mixed';
  status: 'applied' | 'clarification_required' | 'no_action' | 'error';
  actionType: string | null;
  customerId: string | null;
  obligationId: string | null;
  amountMinor: number | null;
  outstandingMinor: number | null;
  clarification: {
    question: string;
    ambiguityKind?: 'customer' | 'obligation' | 'amount' | 'correction' | 'other';
    candidateCustomerIds: string[];
    candidateObligationIds: string[];
  } | null;
  message: string;
  errorCode: string | null;
}

export interface SessionState {
  version: 1;
  sessionId: string;
  userId: string;
  ledgerId: string;
  ledgerCurrency: string;
  preferredCurrency: string;
  createdAt: string;
  updatedAt: string;
  timezone: string;
  recentTurns: ConversationTurnRecord[];
  pendingClarification: PendingClarificationState | null;
  ledgerMutationProposal: LedgerMutationProposal | null;
  demoSeededAt: string | null;
}

export interface TelegramLinkRecord {
  userId: string;
  telegramUserId: string;
  telegramUsername: string | null;
  linkedAt: string | null;
}

export interface LinkTokenRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  telegramUserId: string | null;
  telegramUsername: string | null;
  webSessionToken: string | null;
}

export interface WebSessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuthState {
  version: 1;
  telegramLinks: Record<string, TelegramLinkRecord>;
  linkTokens: Record<string, LinkTokenRecord>;
  webSessions: Record<string, WebSessionRecord>;
}

export interface LoadedSession {
  document: LedgerDocument;
  state: SessionState;
  ledgerPath: string;
  statePath: string;
}

export interface TalliStorageOptions {
  dataDir?: string;
  ledgerFile?: string;
  stateFile?: string;
  authFile?: string;
  defaultSessionId?: string;
  timezone?: string;
  turnHistoryLimit?: number;
}

const DEFAULT_DATA_DIR = '.talli-data';
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_TIMEZONE = 'Africa/Lagos';
const DEFAULT_TURN_HISTORY_LIMIT = 24;

function stripWrappingQuotes(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function envValue(value: string | undefined): string | undefined {
  const trimmed = stripWrappingQuotes(value?.trim());
  return trimmed?.length ? trimmed : undefined;
}

function resolveDataDir(options: TalliStorageOptions): string {
  return (
    envValue(process.env.TALLI_DATA_DIR) ?? options.dataDir ?? join(process.cwd(), DEFAULT_DATA_DIR)
  );
}

function resolveDefaultSessionId(options: TalliStorageOptions): string {
  return options.defaultSessionId ?? DEFAULT_SESSION_ID;
}

function resolveTimezone(options: TalliStorageOptions): string {
  return envValue(process.env.TALLI_TIMEZONE) ?? options.timezone ?? DEFAULT_TIMEZONE;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function defaultState(sessionId: string, timezone: string): SessionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    userId: sessionId,
    ledgerId: sessionId,
    ledgerCurrency: 'NGN',
    preferredCurrency: 'NGN',
    createdAt: now,
    updatedAt: now,
    timezone,
    recentTurns: [],
    pendingClarification: null,
    ledgerMutationProposal: null,
    demoSeededAt: null,
  };
}

function normalizeLedgerMutationProposal(
  proposal: LedgerMutationProposal | null | undefined,
  sessionId: string,
): LedgerMutationProposal | null {
  if (!proposal) {
    return null;
  }

  return {
    ...proposal,
    sessionId: proposal.sessionId || sessionId,
    confirmedAt: proposal.confirmedAt ?? null,
    cancelledAt: proposal.cancelledAt ?? null,
  };
}

function normalizeSessionState(
  state: SessionState,
  sessionId: string,
  timezone: string,
): SessionState {
  return {
    ...defaultState(sessionId, timezone),
    ...state,
    sessionId,
    userId: state.userId ?? sessionId,
    ledgerId: state.ledgerId || sessionId,
    ledgerCurrency: state.ledgerCurrency ?? state.preferredCurrency ?? 'NGN',
    preferredCurrency: state.preferredCurrency ?? state.ledgerCurrency ?? 'NGN',
    timezone: state.timezone || timezone,
    recentTurns: state.recentTurns ?? [],
    pendingClarification: state.pendingClarification ?? null,
    ledgerMutationProposal: normalizeLedgerMutationProposal(
      state.ledgerMutationProposal,
      sessionId,
    ),
    demoSeededAt: state.demoSeededAt ?? null,
  };
}

function defaultAuthState(): AuthState {
  return {
    version: 1,
    telegramLinks: {},
    linkTokens: {},
    webSessions: {},
  };
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rm(filePath, { force: true });
  await rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parseLedgerEvents(raw: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as LedgerEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid ledger event JSON.';
      throw new Error(`Failed to parse ledger event at line ${index + 1}: ${message}`);
    }
  }
  return events;
}

export class TalliSessionStore {
  readonly dataDir: string;
  readonly defaultSessionId: string;
  readonly timezone: string;
  readonly turnHistoryLimit: number;
  private readonly configuredLedgerFile?: string;
  private readonly configuredStateFile?: string;
  private readonly configuredAuthFile?: string;

  constructor(options: TalliStorageOptions = {}) {
    this.dataDir = resolveDataDir(options);
    this.defaultSessionId = resolveDefaultSessionId(options);
    this.timezone = resolveTimezone(options);
    this.turnHistoryLimit = options.turnHistoryLimit ?? DEFAULT_TURN_HISTORY_LIMIT;
    this.configuredLedgerFile = envValue(process.env.TALLI_LEDGER_FILE) ?? options.ledgerFile;
    this.configuredStateFile = envValue(process.env.TALLI_STATE_FILE) ?? options.stateFile;
    this.configuredAuthFile = envValue(process.env.TALLI_AUTH_FILE) ?? options.authFile;
  }

  resolveSessionPaths(sessionId = this.defaultSessionId): {
    ledgerPath: string;
    statePath: string;
    sessionDir: string;
  } {
    if (sessionId === this.defaultSessionId && this.configuredLedgerFile) {
      const ledgerPath = this.configuredLedgerFile;
      const statePath =
        this.configuredStateFile ??
        `${ledgerPath}.state.json`.replace(/\.ndjson\.state\.json$/, '.state.json');
      return {
        ledgerPath,
        statePath,
        sessionDir: dirname(ledgerPath),
      };
    }

    const sessionDir = join(this.dataDir, 'sessions', sanitizeSessionId(sessionId));
    return {
      ledgerPath: join(sessionDir, 'ledger.ndjson'),
      statePath: join(sessionDir, 'state.json'),
      sessionDir,
    };
  }

  resolveAuthPath(): string {
    if (this.configuredAuthFile) {
      return this.configuredAuthFile;
    }
    if (this.configuredLedgerFile) {
      return `${this.configuredLedgerFile}.auth.json`.replace(
        /\.ndjson\.auth\.json$/,
        '.auth.json',
      );
    }
    return join(this.dataDir, 'auth.json');
  }

  private async loadAuthState(): Promise<AuthState> {
    return (await readJsonFile<AuthState>(this.resolveAuthPath())) ?? defaultAuthState();
  }

  private async saveAuthState(state: AuthState): Promise<void> {
    await writeJsonAtomic(this.resolveAuthPath(), state);
  }

  private ensureStateIdentity(state: SessionState, sessionId: string): SessionState {
    return normalizeSessionState(state, sessionId, this.timezone);
  }

  async load(sessionId = this.defaultSessionId): Promise<LoadedSession> {
    const { ledgerPath, statePath, sessionDir } = this.resolveSessionPaths(sessionId);
    await mkdir(sessionDir, { recursive: true });

    const state =
      (await readJsonFile<SessionState>(statePath)) ?? defaultState(sessionId, this.timezone);
    const document = await this.loadDocumentFromEvents(
      ledgerPath,
      state.ledgerId,
      state.ledgerCurrency ?? 'NGN',
    );

    return {
      document,
      state: this.ensureStateIdentity(state, sessionId),
      ledgerPath,
      statePath,
    };
  }

  async loadDocumentFromEvents(
    ledgerPath: string,
    ledgerId: string,
    currency: string,
  ): Promise<LedgerDocument> {
    try {
      const raw = await readFile(ledgerPath, 'utf8');
      const events = parseLedgerEvents(raw);
      return {
        ...createLedgerDocument(ledgerId, currency),
        id: ledgerId,
        events,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createLedgerDocument(ledgerId, currency);
      }
      throw error;
    }
  }

  async save(session: {
    document: LedgerDocument;
    state: SessionState;
    ledgerPath: string;
    statePath: string;
  }): Promise<void> {
    await this.replaceLedger(session.ledgerPath, session.document);
    await writeJsonAtomic(session.statePath, session.state);
  }

  async saveState(statePath: string, state: SessionState): Promise<void> {
    await writeJsonAtomic(statePath, state);
  }

  async appendEvents(ledgerPath: string, events: LedgerEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await mkdir(dirname(ledgerPath), { recursive: true });
    const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('');
    await writeFile(ledgerPath, lines, { encoding: 'utf8', flag: 'a' });
  }

  async replaceLedger(ledgerPath: string, document: LedgerDocument): Promise<void> {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const contents = `${document.events.map((event) => JSON.stringify(event)).join('\n')}${document.events.length > 0 ? '\n' : ''}`;
    await writeFile(ledgerPath, contents, 'utf8');
  }

  async reset(sessionId = this.defaultSessionId): Promise<void> {
    const { ledgerPath, statePath, sessionDir } = this.resolveSessionPaths(sessionId);
    await rm(sessionDir, { recursive: true, force: true });
    await mkdir(sessionDir, { recursive: true });
    const state = defaultState(sessionId, this.timezone);
    const document = createLedgerDocument(state.ledgerId, state.ledgerCurrency);
    await this.save({ document, state, ledgerPath, statePath });
  }

  async seed(
    seed: {
      document: LedgerDocument;
      state?: Partial<SessionState>;
    },
    sessionId = this.defaultSessionId,
  ): Promise<void> {
    const { ledgerPath, statePath, sessionDir } = this.resolveSessionPaths(sessionId);
    await mkdir(sessionDir, { recursive: true });
    const baseState = defaultState(sessionId, this.timezone);
    const nextState: SessionState = {
      ...baseState,
      ...seed.state,
      sessionId,
      userId: seed.state?.userId ?? baseState.userId,
      ledgerId: seed.state?.ledgerId ?? seed.document.id,
      ledgerCurrency:
        seed.state?.ledgerCurrency ?? seed.document.currency ?? baseState.ledgerCurrency,
      preferredCurrency:
        seed.state?.preferredCurrency ??
        seed.state?.ledgerCurrency ??
        seed.document.currency ??
        baseState.preferredCurrency,
      createdAt: seed.state?.createdAt ?? baseState.createdAt,
      updatedAt: new Date().toISOString(),
      recentTurns: seed.state?.recentTurns ?? [],
      pendingClarification: seed.state?.pendingClarification ?? null,
      ledgerMutationProposal:
        normalizeLedgerMutationProposal(seed.state?.ledgerMutationProposal, sessionId) ?? null,
      demoSeededAt: seed.state?.demoSeededAt ?? new Date().toISOString(),
    };
    const nextDocument = {
      ...seed.document,
      id: nextState.ledgerId,
      currency: nextState.ledgerCurrency,
    };
    await this.save({ document: nextDocument, state: nextState, ledgerPath, statePath });
  }

  async updateState(
    sessionId: string,
    updater: (state: SessionState) => SessionState,
  ): Promise<void> {
    const loaded = await this.load(sessionId);
    const nextState = updater(loaded.state);
    await this.save({
      document: loaded.document,
      state: nextState,
      ledgerPath: loaded.ledgerPath,
      statePath: loaded.statePath,
    });
  }

  async clear(sessionId = this.defaultSessionId): Promise<void> {
    const { sessionDir } = this.resolveSessionPaths(sessionId);
    await rm(sessionDir, { recursive: true, force: true });
  }

  async getTelegramLink(telegramUserId: string): Promise<TelegramLinkRecord | null> {
    const auth = await this.loadAuthState();
    return auth.telegramLinks[telegramUserId] ?? null;
  }

  async disconnectTelegram(sessionId: string): Promise<void> {
    const auth = await this.loadAuthState();
    let changed = false;
    for (const [telegramUserId, record] of Object.entries(auth.telegramLinks)) {
      if (record.userId !== sessionId) {
        continue;
      }
      delete auth.telegramLinks[telegramUserId];
      changed = true;
    }
    if (changed) {
      await this.saveAuthState(auth);
    }
  }

  async createTelegramLinkToken(
    options: {
      sessionId?: string;
      ttlMs?: number;
    } = {},
  ): Promise<LinkTokenRecord> {
    const auth = await this.loadAuthState();
    const now = Date.now();
    const sessionId = options.sessionId ?? randomUUID();
    const token = randomUUID();
    const record: LinkTokenRecord = {
      token,
      userId: sessionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (options.ttlMs ?? 10 * 60 * 1000)).toISOString(),
      consumedAt: null,
      telegramUserId: null,
      telegramUsername: null,
      webSessionToken: null,
    };
    auth.linkTokens[token] = record;
    await this.saveAuthState(auth);
    return record;
  }

  async getTelegramLinkToken(token: string): Promise<LinkTokenRecord | null> {
    const auth = await this.loadAuthState();
    return auth.linkTokens[token] ?? null;
  }

  async consumeTelegramLinkToken(input: {
    token: string;
    telegramUserId: string;
    telegramUsername?: string | null;
  }): Promise<{ userId: string; webSessionToken: string } | null> {
    const auth = await this.loadAuthState();
    const tokenRecord = auth.linkTokens[input.token];
    if (!tokenRecord || tokenRecord.consumedAt) {
      return null;
    }
    if (new Date(tokenRecord.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    const now = new Date().toISOString();
    const webSessionToken = `ws_${randomUUID().replace(/-/g, '')}`;
    auth.linkTokens[input.token] = {
      ...tokenRecord,
      consumedAt: now,
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername ?? null,
      webSessionToken,
    };
    auth.telegramLinks[input.telegramUserId] = {
      userId: tokenRecord.userId,
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername ?? null,
      linkedAt: now,
    };
    auth.webSessions[webSessionToken] = {
      token: webSessionToken,
      userId: tokenRecord.userId,
      createdAt: now,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
    };
    await this.saveAuthState(auth);
    return {
      userId: tokenRecord.userId,
      webSessionToken,
    };
  }

  async resolveWebSession(webSessionToken: string): Promise<string | null> {
    const auth = await this.loadAuthState();
    const session = auth.webSessions[webSessionToken];
    if (!session || session.revokedAt) {
      return null;
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    return session.userId;
  }

  async getWebSession(webSessionToken: string): Promise<WebSessionRecord | null> {
    const auth = await this.loadAuthState();
    return auth.webSessions[webSessionToken] ?? null;
  }

  async getUserIdentity(sessionId: string): Promise<{
    userId: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
  }> {
    const auth = await this.loadAuthState();
    const link =
      Object.values(auth.telegramLinks).find((entry) => entry.userId === sessionId) ?? null;
    return {
      userId: sessionId,
      telegramUserId: link?.telegramUserId ?? null,
      telegramUsername: link?.telegramUsername ?? null,
    };
  }

  async setPreferredCurrency(sessionId: string, currency: string): Promise<void> {
    const loaded = await this.load(sessionId);
    const nextState: SessionState = {
      ...loaded.state,
      ledgerCurrency: currency,
      preferredCurrency: currency,
      updatedAt: new Date().toISOString(),
    };
    const nextDocument = {
      ...loaded.document,
      currency,
    };
    await this.save({
      document: nextDocument,
      state: nextState,
      ledgerPath: loaded.ledgerPath,
      statePath: loaded.statePath,
    });
  }
}

export function createDefaultSessionState(sessionId: string, timezone: string): SessionState {
  return defaultState(sessionId, timezone);
}

export async function readSessionState(filePath: string): Promise<SessionState | null> {
  return readJsonFile<SessionState>(filePath);
}

export async function writeSessionState(filePath: string, state: SessionState): Promise<void> {
  await writeJsonAtomic(filePath, state);
}
