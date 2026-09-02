import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public app renderer source', () => {
  it('keeps the browser collaboration wiring visible in source', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');
    expect(appSource).not.toContain('&middot;');
    expect(appSource).toContain('await loadCurrentProposal();');
    expect(appSource).toContain("dom.proposalConfirm?.addEventListener('click'");
    expect(appSource).toContain('registerTalliWebMcpTools');
    expect(appSource).toContain('abortTalliWebMcpTools');
    expect(appSource).not.toContain('confirm_ledger_mutation');

    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    expect(html).toContain('data-role="proposal-panel"');
    expect(html).toContain('Agent prepared a ledger change');
    expect(html).toContain('Collaboration at a glance');
  });
});
