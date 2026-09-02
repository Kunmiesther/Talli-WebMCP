import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('static frontend serving', () => {
  it('serves the Talli frontend and assets regardless of cwd', async () => {
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'talli-static-'));

    process.chdir(tempDir);
    vi.resetModules();

    try {
      const [{ handleTalliApiRequest }, { createTalliService }] = await Promise.all([
        import('../src/app/api.js'),
        import('../src/app/talli-service.js'),
      ]);
      const service = createTalliService({ interpreter: null });

      const rootResponse = await handleTalliApiRequest(service, new Request('http://localhost/'));
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.headers.get('content-type')).toContain('text/html');
      expect(rootResponse.headers.get('origin-agent-cluster')).toBe('?1');
      expect(rootResponse.headers.get('permissions-policy')).toBe('tools=(self)');
      const rootHtml = await rootResponse.text();
      expect(rootHtml).toContain('Talli');
      expect(rootHtml).not.toContain('Seed demo');
      expect(rootHtml).not.toContain('Reset demo');
      expect(rootHtml).not.toContain('hackathon project');
      expect(rootHtml).not.toContain('API online');
      expect(rootHtml).not.toContain('provider');
      expect(rootHtml).not.toContain('Implemented capabilities, not generic AI claims');
      expect(rootHtml).not.toContain('Financial state should not change');
      expect(rootHtml).not.toContain('Waiting for Telegram');
      expect(rootHtml).toContain('Open Talli in Telegram');
      expect(rootHtml).toContain('Speak here');
      expect(rootHtml).toContain('What Talli can help you with');
      expect(rootHtml).not.toContain('hero__visual reveal');
      expect(rootHtml).not.toContain('use-cases__media reveal');
      expect(rootHtml).not.toContain('photo-card--story reveal');

      const cssResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/styles.css'),
      );
      expect(cssResponse.status).toBe(200);
      expect(cssResponse.headers.get('content-type')).toContain('text/css');
      expect(cssResponse.headers.get('origin-agent-cluster')).toBe('?1');
      expect(cssResponse.headers.get('permissions-policy')).toBe('tools=(self)');

      const jsResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/app.js'),
      );
      expect(jsResponse.status).toBe(200);
      expect(jsResponse.headers.get('content-type')).toContain('text/javascript');

      for (const assetPath of [
        '/assets/hero-merchant.png',
        '/assets/ledger-closeup.png',
        '/assets/market-conversation.png',
        '/assets/merchant-balance-review.png',
        '/assets/notebook-ledger.png',
      ]) {
        const assetResponse = await handleTalliApiRequest(
          service,
          new Request(`http://localhost${assetPath}`),
        );
        expect(assetResponse.status).toBe(200);
        expect(assetResponse.headers.get('content-type')).toContain('image/png');
        expect((await assetResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }

      const fontCssResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/vendor/fontawesome/css/all.min.css'),
      );
      expect(fontCssResponse.status).toBe(200);
      expect(fontCssResponse.headers.get('content-type')).toContain('text/css');

      const fontResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/vendor/fontawesome/webfonts/fa-solid-900.woff2'),
      );
      expect(fontResponse.status).toBe(200);
      expect(fontResponse.headers.get('content-type')).toContain('font/woff2');
      expect((await fontResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);

      const healthResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/health'),
      );
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.headers.get('content-type')).toContain('application/json');
      expect(healthResponse.headers.get('origin-agent-cluster')).toBe('?1');
      expect(healthResponse.headers.get('permissions-policy')).toBe('tools=(self)');
      expect(await healthResponse.json()).toMatchObject({ ok: true });

      const ledgerResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/ledger'),
      );
      expect(ledgerResponse.status).toBe(200);
      expect(await ledgerResponse.json()).toMatchObject({
        customers: [],
        obligations: [],
      });

      const unknownApiResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/unknown-route'),
      );
      expect(unknownApiResponse.status).toBe(404);
      expect(await unknownApiResponse.json()).toMatchObject({
        status: 'error',
        errorCode: 'NOT_FOUND',
      });
    } finally {
      process.chdir(originalCwd);
      vi.resetModules();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves PNG bytes when an asset is served through the real HTTP bridge', async () => {
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'talli-static-http-'));

    process.chdir(tempDir);
    vi.resetModules();

    try {
      const [{ createTalliHttpServer }, { createTalliService }] = await Promise.all([
        import('../src/app/api.js'),
        import('../src/app/talli-service.js'),
      ]);
      const service = createTalliService({ interpreter: null });
      const server = createTalliHttpServer(service, 0);

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });

      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const sourcePath = join(originalCwd, 'public', 'assets', 'hero-merchant.png');
        const sourceBytes = await readFile(sourcePath);
        const response = await fetch(`http://127.0.0.1:${port}/assets/hero-merchant.png`);
        const servedBytes = Buffer.from(await response.arrayBuffer());

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('image/png');
        expect(Array.from(servedBytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(servedBytes.equals(sourceBytes)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      process.chdir(originalCwd);
      vi.resetModules();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
