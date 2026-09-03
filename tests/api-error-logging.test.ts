import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';

describe('API error logging', () => {
  it('logs a safe structured record for unexpected Telegram link-token failures', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'talli-api-error-'));
    const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
    const service = createTalliService({ store, interpreter: null });
    const error = Object.assign(new Error('foreign key violation'), {
      name: 'SupabaseRequestError',
      code: '23503',
      details: 'Key (user_id)=(demo) is not present in table "talli_users".',
      hint: 'Create the parent row first.',
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => void 0);
    vi.spyOn(service, 'createTelegramLinkToken').mockRejectedValue(error);

    try {
      const response = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/auth/telegram/link-token', {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret-token',
            cookie: 'talli_session=secret-session',
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        status: 'error',
        errorCode: 'INTERNAL_ERROR',
        message: 'The ledger could not process that request safely.',
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [label, context] = consoleSpy.mock.calls[0] ?? [];
      expect(label).toBe('Talli API unexpected error');
      expect(context).toMatchObject({
        method: 'POST',
        pathname: '/api/auth/telegram/link-token',
        errorName: 'SupabaseRequestError',
        errorMessage: 'foreign key violation',
        errorCode: '23503',
        errorDetails: 'Key (user_id)=(demo) is not present in table "talli_users".',
        errorHint: 'Create the parent row first.',
      });
      expect(JSON.stringify(context)).not.toContain('secret-token');
      expect(JSON.stringify(context)).not.toContain('secret-session');
    } finally {
      consoleSpy.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
