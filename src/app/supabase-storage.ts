import { randomUUID } from 'node:crypto';
import { type LedgerDocument, type LedgerEvent, createLedgerDocument } from '../domain/ledger.js';
import type { TalliStorageBackend } from './storage-contract.js';
import type {
  AuthState,
  LinkTokenRecord,
  LoadedSession,
  SessionState,
  TelegramLinkRecord,
  WebSessionRecord,
} from './storage.js';

interface SupabaseOptions {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  defaultSessionId?: string;
  timezone?: string;
  turnHistoryLimit?: number;
}

interface SupabaseRow {
  [key: string]: unknown;
}

interface SupabaseErrorPayload {
  code?: string;
  details?: string;
  hint?: string;
  message?: string;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseSupabaseErrorPayload(text: string): SupabaseErrorPayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    return {
      code: typeof payload.code === 'string' ? payload.code : undefined,
      details: typeof payload.details === 'string' ? payload.details : undefined,
      hint: typeof payload.hint === 'string' ? payload.hint : undefined,
      message: typeof payload.message === 'string' ? payload.message : undefined,
    };
  } catch {
    return null;
  }
}

function createSupabaseRequestError(path: string, response: Response, text: string): Error {
  const payload = parseSupabaseErrorPayload(text);
  const message = payload?.message?.trim() || text.trim() || `Supabase request failed: ${path}`;
  const error = new Error(message);
  error.name = 'SupabaseRequestError';
  if (payload?.code) {
    (error as Error & { code?: string }).code = payload.code;
  }
  if (payload?.details) {
    (error as Error & { details?: string }).details = payload.details;
  }
  if (payload?.hint) {
    (error as Error & { hint?: string }).hint = payload.hint;
  }
  (error as Error & { path?: string }).path = path;
  (error as Error & { status?: number }).status = response.status;
  return error;
}

function buildPreferHeader(path: string, preferValue: string | null): string {
  const preferences = new Set(
    (preferValue ?? 'return=minimal')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  if (path.includes('?on_conflict=')) {
    preferences.add('resolution=merge-duplicates');
  }

  if (![...preferences].some((value) => value.startsWith('return='))) {
    preferences.add('return=minimal');
  }

  return [...preferences].join(',');
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

function defaultAuthState(): AuthState {
  return {
    version: 1,
    telegramLinks: {},
    linkTokens: {},
    webSessions: {},
  };
}

export class SupabaseTalliSessionStore implements TalliStorageBackend {
  readonly defaultSessionId: string;
  readonly timezone: string;
  readonly turnHistoryLimit: number;

  private readonly supabaseUrl: string;
  private readonly supabaseServiceRoleKey: string;

  constructor(options: SupabaseOptions) {
    this.supabaseUrl = stripTrailingSlash(options.supabaseUrl);
    this.supabaseServiceRoleKey = options.supabaseServiceRoleKey;
    this.defaultSessionId = options.defaultSessionId ?? 'default';
    this.timezone = options.timezone ?? 'Africa/Lagos';
    this.turnHistoryLimit = options.turnHistoryLimit ?? 24;
  }

  private async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set('apikey', this.supabaseServiceRoleKey);
    headers.set('Authorization', `Bearer ${this.supabaseServiceRoleKey}`);
    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
    headers.set('Prefer', buildPreferHeader(path, headers.get('Prefer')));
    const response = await fetch(`${this.supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw createSupabaseRequestError(path, response, text);
    }
    return response;
  }

  private async select(path: string): Promise<SupabaseRow[]> {
    const response = await fetch(`${this.supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: this.supabaseServiceRoleKey,
        Authorization: `Bearer ${this.supabaseServiceRoleKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw createSupabaseRequestError(path, response, text);
    }
    return (await response.json()) as SupabaseRow[];
  }

  private async ensureTalliUsers(userIds: Iterable<string>): Promise<void> {
    const uniqueUserIds = [
      ...new Set(
        Array.from(userIds)
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];
    if (uniqueUserIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    await this.request('talli_users?on_conflict=id', {
      method: 'POST',
      body: JSON.stringify(
        uniqueUserIds.map((id) => ({
          id,
          updated_at: now,
        })),
      ),
    });
  }

  private sessionKey(sessionId: string): string {
    return sessionId;
  }

  private ledgerPathFor(sessionId: string): string {
    return `supabase://${this.sessionKey(sessionId)}/ledger.ndjson`;
  }

  private statePathFor(sessionId: string): string {
    return `supabase://${this.sessionKey(sessionId)}/state.json`;
  }

  private sessionIdFromPath(path: string): string {
    const match = /^supabase:\/\/([^/]+)\//.exec(path);
    if (!match) {
      return this.defaultSessionId;
    }
    return match[1] ?? this.defaultSessionId;
  }

  private async loadAuthState(): Promise<AuthState> {
    const [telegramLinkRows, linkTokenRows, webSessionRows] = await Promise.all([
      this.select('telegram_links?select=*'),
      this.select('link_tokens?select=*'),
      this.select('web_sessions?select=*'),
    ]);

    const auth = defaultAuthState();
    for (const row of telegramLinkRows) {
      const telegramUserId = String(row.telegram_user_id);
      auth.telegramLinks[telegramUserId] = {
        userId: String(row.user_id),
        telegramUserId,
        telegramUsername: (row.telegram_username as string | null) ?? null,
        linkedAt: (row.linked_at as string | null) ?? null,
      };
    }

    for (const row of linkTokenRows) {
      const token = String(row.token);
      auth.linkTokens[token] = {
        token,
        userId: String(row.user_id),
        createdAt: (row.created_at as string | null) ?? new Date().toISOString(),
        expiresAt: String(row.expires_at ?? new Date().toISOString()),
        consumedAt: (row.consumed_at as string | null) ?? null,
        telegramUserId: (row.telegram_user_id as string | null) ?? null,
        telegramUsername: (row.telegram_username as string | null) ?? null,
        webSessionToken: (row.web_session_token as string | null) ?? null,
      };
    }

    for (const row of webSessionRows) {
      const token = String(row.token);
      auth.webSessions[token] = {
        token,
        userId: String(row.user_id),
        createdAt: (row.created_at as string | null) ?? new Date().toISOString(),
        expiresAt: String(row.expires_at ?? new Date().toISOString()),
        revokedAt: (row.revoked_at as string | null) ?? null,
      };
    }

    return auth;
  }

  private async saveAuthState(state: AuthState): Promise<void> {
    await this.ensureTalliUsers([
      ...Object.values(state.telegramLinks).map((record) => record.userId),
      ...Object.values(state.linkTokens).map((record) => record.userId),
      ...Object.values(state.webSessions).map((record) => record.userId),
    ]);
    await this.request('telegram_links?on_conflict=telegram_user_id', {
      method: 'POST',
      body: JSON.stringify(
        Object.values(state.telegramLinks).map((record) => ({
          telegram_user_id: record.telegramUserId,
          user_id: record.userId,
          telegram_username: record.telegramUsername,
          linked_at: record.linkedAt,
        })),
      ),
    });
    await this.request('link_tokens?on_conflict=token', {
      method: 'POST',
      body: JSON.stringify(
        Object.values(state.linkTokens).map((record) => ({
          token: record.token,
          user_id: record.userId,
          created_at: record.createdAt,
          expires_at: record.expiresAt,
          consumed_at: record.consumedAt,
          telegram_user_id: record.telegramUserId,
          telegram_username: record.telegramUsername,
          web_session_token: record.webSessionToken,
        })),
      ),
    });
    await this.request('web_sessions?on_conflict=token', {
      method: 'POST',
      body: JSON.stringify(
        Object.values(state.webSessions).map((record) => ({
          token: record.token,
          user_id: record.userId,
          created_at: record.createdAt,
          expires_at: record.expiresAt,
          revoked_at: record.revokedAt,
        })),
      ),
    });
  }

  private async upsertState(sessionId: string, state: SessionState): Promise<void> {
    await this.ensureTalliUsers([sessionId]);
    await this.request('conversation_sessions?on_conflict=user_id', {
      method: 'POST',
      body: JSON.stringify([
        {
          user_id: sessionId,
          payload: state,
          updated_at: new Date().toISOString(),
        },
      ]),
    });
  }

  async load(sessionId = this.defaultSessionId): Promise<LoadedSession> {
    const stateRows = await this.select(
      `conversation_sessions?select=payload&user_id=eq.${encodeURIComponent(sessionId)}&limit=1`,
    );
    const state =
      (stateRows[0]?.payload as SessionState | undefined) ?? defaultState(sessionId, this.timezone);
    const eventRows = await this.select(
      `ledger_events?select=event_json,created_at&user_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc`,
    );
    const document = createLedgerDocument(state.ledgerId, state.ledgerCurrency);
    document.events = eventRows.map((row) => row.event_json as LedgerEvent);
    return {
      document,
      state: {
        ...defaultState(sessionId, this.timezone),
        ...state,
        sessionId,
        userId: state.userId ?? sessionId,
        ledgerId: state.ledgerId || sessionId,
        ledgerCurrency: state.ledgerCurrency ?? state.preferredCurrency ?? 'NGN',
        preferredCurrency: state.preferredCurrency ?? state.ledgerCurrency ?? 'NGN',
        timezone: state.timezone || this.timezone,
        recentTurns: state.recentTurns ?? [],
        pendingClarification: state.pendingClarification ?? null,
        ledgerMutationProposal: state.ledgerMutationProposal ?? null,
        demoSeededAt: state.demoSeededAt ?? null,
      },
      ledgerPath: this.ledgerPathFor(sessionId),
      statePath: this.statePathFor(sessionId),
    };
  }

  async save(session: {
    document: LedgerDocument;
    state: SessionState;
    ledgerPath: string;
    statePath: string;
  }): Promise<void> {
    const sessionId = this.sessionIdFromPath(session.statePath);
    await this.replaceLedger(session.ledgerPath, session.document);
    await this.saveState(session.statePath, session.state);
    await this.upsertState(sessionId, session.state);
  }

  async saveState(statePath: string, state: SessionState): Promise<void> {
    const sessionId = this.sessionIdFromPath(statePath);
    await this.ensureTalliUsers([sessionId]);
    await this.request('conversation_sessions?on_conflict=user_id', {
      method: 'POST',
      body: JSON.stringify([
        {
          user_id: sessionId,
          payload: state,
          updated_at: new Date().toISOString(),
        },
      ]),
    });
    await this.request('user_preferences?on_conflict=user_id', {
      method: 'POST',
      body: JSON.stringify([
        {
          user_id: sessionId,
          preferred_currency: state.preferredCurrency ?? state.ledgerCurrency,
          updated_at: new Date().toISOString(),
        },
      ]),
    });
  }

  async appendEvents(ledgerPath: string, events: LedgerEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const sessionId = this.sessionIdFromPath(ledgerPath);
    await this.ensureTalliUsers([sessionId]);
    await this.request('ledger_events', {
      method: 'POST',
      body: JSON.stringify(
        events.map((event) => ({
          id: randomUUID(),
          user_id: sessionId,
          ledger_id: sessionId,
          event_json: event,
          created_at: new Date().toISOString(),
        })),
      ),
    });
  }

  async replaceLedger(ledgerPath: string, document: LedgerDocument): Promise<void> {
    const sessionId = this.sessionIdFromPath(ledgerPath);
    await this.request(`ledger_events?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    await this.appendEvents(ledgerPath, document.events);
  }

  async reset(sessionId = this.defaultSessionId): Promise<void> {
    await this.request(`ledger_events?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    await this.request(`conversation_sessions?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    await this.request(`user_preferences?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    await this.request(`conversation_turns?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    await this.request(`telegram_links?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    await this.request(`web_sessions?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async seed(
    seed: {
      document: LedgerDocument;
      state?: Partial<SessionState>;
    },
    sessionId = this.defaultSessionId,
  ): Promise<void> {
    const state = {
      ...defaultState(sessionId, this.timezone),
      ...seed.state,
      sessionId,
      userId: seed.state?.userId ?? sessionId,
      ledgerId: seed.state?.ledgerId ?? seed.document.id,
      ledgerCurrency:
        seed.state?.ledgerCurrency ??
        seed.document.currency ??
        seed.state?.preferredCurrency ??
        'NGN',
      preferredCurrency:
        seed.state?.preferredCurrency ??
        seed.state?.ledgerCurrency ??
        seed.document.currency ??
        'NGN',
      updatedAt: new Date().toISOString(),
      recentTurns: seed.state?.recentTurns ?? [],
      pendingClarification: seed.state?.pendingClarification ?? null,
      ledgerMutationProposal: seed.state?.ledgerMutationProposal ?? null,
    };
    await this.save({
      document: {
        ...seed.document,
        id: state.ledgerId,
        currency: state.ledgerCurrency,
      },
      state,
      ledgerPath: this.ledgerPathFor(sessionId),
      statePath: this.statePathFor(sessionId),
    });
  }

  async updateState(
    sessionId: string,
    updater: (state: SessionState) => SessionState,
  ): Promise<void> {
    const loaded = await this.load(sessionId);
    await this.save({
      document: loaded.document,
      state: updater(loaded.state),
      ledgerPath: loaded.ledgerPath,
      statePath: loaded.statePath,
    });
  }

  async clear(sessionId = this.defaultSessionId): Promise<void> {
    await this.reset(sessionId);
  }

  async getTelegramLink(telegramUserId: string): Promise<TelegramLinkRecord | null> {
    const rows = await this.select(
      `telegram_links?select=*&telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&limit=1`,
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      userId: String(row.user_id),
      telegramUserId: String(row.telegram_user_id),
      telegramUsername: (row.telegram_username as string | null) ?? null,
      linkedAt: (row.linked_at as string | null) ?? null,
    };
  }

  async disconnectTelegram(sessionId: string): Promise<void> {
    await this.request(`telegram_links?user_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
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
    await this.save({
      document: {
        ...loaded.document,
        currency,
      },
      state: {
        ...loaded.state,
        ledgerCurrency: currency,
        preferredCurrency: currency,
        updatedAt: new Date().toISOString(),
      },
      ledgerPath: loaded.ledgerPath,
      statePath: loaded.statePath,
    });
  }
}
