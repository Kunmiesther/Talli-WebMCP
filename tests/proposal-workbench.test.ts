import { describe, expect, it } from 'vitest';
import {
  appendProposalActivity,
  beginProposalAction,
  createProposalActivityEntry,
  createProposalWorkbenchState,
  finishProposalAction,
  formatConfirmStateMessage,
  formatProposalActivityMessage,
  isProposalActionable,
  normalizeProposalActivityLog,
  withCurrentProposal,
  withProposalOutcome,
} from '../public/proposal-workbench.js';

function createProposal() {
  return {
    proposalId: 'proposal-1',
    operation: 'RECORD_PAYMENT',
    summary: 'Record payment of NGN 1,000 for Sarah.',
    status: 'pending',
    createdAt: '2026-09-02T10:00:00.000Z',
    expiresAt: '2026-09-02T10:10:00.000Z',
    confirmedAt: null,
    cancelledAt: null,
  };
}

describe('proposal workbench state helpers', () => {
  it('restores the current pending proposal without guessing', () => {
    const initial = createProposalWorkbenchState();
    const next = withCurrentProposal(initial, createProposal());

    expect(next.activeProposal).toMatchObject({
      proposalId: 'proposal-1',
      status: 'pending',
    });
    expect(next.overlay).toBeNull();
    expect(next.busyAction).toBeNull();
  });

  it('prevents duplicate confirmation attempts while a proposal is busy', () => {
    const current = withCurrentProposal(createProposalWorkbenchState(), createProposal());
    const first = beginProposalAction(current, 'confirm');
    expect(first.started).toBe(true);

    const second = beginProposalAction(first.state, 'confirm');
    expect(second.started).toBe(false);
    expect(second.state.busyAction).toBe('confirm');
  });

  it('clears the actionable proposal after confirmation or rejection', () => {
    const current = withCurrentProposal(createProposalWorkbenchState(), createProposal());

    const confirmed = finishProposalAction(current, {
      status: 'confirmed',
      message: 'Confirmed: Record payment of NGN 1,000 for Sarah.',
      proposal: createProposal(),
    });
    expect(confirmed.activeProposal).toBeNull();
    expect(confirmed.overlay).toMatchObject({ status: 'confirmed' });

    const rejected = finishProposalAction(current, {
      status: 'rejected',
      reasonCode: 'PROPOSAL_NOT_FOUND',
      message: 'No matching proposal exists for this session.',
      proposal: null,
    });
    expect(rejected.activeProposal).toBeNull();
    expect(rejected.overlay).toMatchObject({ status: 'rejected' });
  });

  it('keeps a bounded collaboration activity trail', () => {
    const activity0: Array<{ timestamp: string; message: string; kind: string }> = [];
    const activity1 = appendProposalActivity(activity0, { message: 'Agent checked the ledger.' });
    const activity2 = appendProposalActivity(activity1, { message: 'Agent searched customers.' });
    const activity3 = appendProposalActivity(activity2, { message: 'Agent prepared a payment.' });
    const activity4 = appendProposalActivity(activity3, { message: 'You confirmed the change.' });
    const activity5 = appendProposalActivity(activity4, { message: 'Proposal cancelled.' });

    expect(activity5).toHaveLength(4);
    expect(activity5.at(-1)?.message).toBe('Proposal cancelled.');
    expect(activity5[0]?.message).toBe('Agent searched customers.');
  });

  it('creates canonical activity entries and drops malformed legacy entries', () => {
    const canonical = createProposalActivityEntry('Agent checked the ledger summary.');
    expect(canonical).toMatchObject({
      message: 'Agent checked the ledger summary.',
      kind: 'info',
    });
    expect(typeof canonical?.timestamp).toBe('string');

    const normalized = normalizeProposalActivityLog([
      { timestamp: '2026-09-02T10:00:00.000Z', message: { text: 'bad' } },
      { timestamp: '2026-09-02T10:01:00.000Z', message: '[object Object]' },
      {
        timestamp: '2026-09-02T10:02:00.000Z',
        message: '  Agent checked the ledger summary.  ',
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      timestamp: '2026-09-02T10:02:00.000Z',
      message: 'Agent checked the ledger summary.',
      kind: 'info',
    });

    const discarded = appendProposalActivity([], { message: { nested: true } as never });
    expect(discarded).toHaveLength(0);
  });

  it('formats operation-specific confirmation and collaboration copy', () => {
    expect(
      formatConfirmStateMessage({
        status: 'confirmed',
        proposal: { ...createProposal(), operation: 'CREATE_OBLIGATION' },
      }),
    ).toBe('You confirmed the credit entry.');
    expect(
      formatConfirmStateMessage({
        status: 'confirmed',
        proposal: { ...createProposal(), operation: 'RECORD_PAYMENT' },
      }),
    ).toBe('You confirmed the payment.');
    expect(
      formatConfirmStateMessage({
        status: 'confirmed',
        proposal: { ...createProposal(), operation: 'SETTLE_OBLIGATION' },
      }),
    ).toBe('You confirmed the settlement.');
    expect(
      formatConfirmStateMessage({
        status: 'confirmed',
        proposal: { ...createProposal(), operation: 'UNKNOWN_OPERATION' },
      }),
    ).toBe('You confirmed the ledger change.');

    expect(formatProposalActivityMessage('prepare', 'CREATE_OBLIGATION')).toBe(
      'Agent prepared a credit entry for review.',
    );
    expect(formatProposalActivityMessage('cancel', 'RECORD_PAYMENT')).toBe(
      'You cancelled the payment.',
    );
    expect(formatProposalActivityMessage('clarification', 'SETTLE_OBLIGATION')).toBe(
      'Agent found ambiguity while preparing a settlement and did not guess.',
    );
  });

  it('keeps confirmed, cancelled, and expired proposals non-actionable', () => {
    const current = withCurrentProposal(createProposalWorkbenchState(), createProposal());

    const confirmed = finishProposalAction(current, {
      status: 'confirmed',
      message: 'Confirmed.',
      proposal: createProposal(),
    });
    expect(confirmed.activeProposal).toBeNull();
    expect(isProposalActionable(confirmed)).toBe(false);

    const cancelled = finishProposalAction(current, {
      status: 'cancelled',
      message: 'Cancelled.',
      proposal: createProposal(),
    });
    expect(cancelled.activeProposal).toBeNull();
    expect(isProposalActionable(cancelled)).toBe(false);

    const expired = finishProposalAction(current, {
      status: 'expired',
      reasonCode: 'PROPOSAL_EXPIRED',
      message: 'Expired.',
      proposal: createProposal(),
    });
    expect(expired.activeProposal).toBeNull();
    expect(isProposalActionable(expired)).toBe(false);
  });

  it('stores overlay outcomes without replacing a pending proposal on clarification', () => {
    const current = withCurrentProposal(createProposalWorkbenchState(), createProposal());
    const next = withProposalOutcome(current, {
      status: 'clarification_required',
      reasonCode: 'AMBIGUOUS_CUSTOMER',
      message: 'Multiple customers match that reference.',
      candidates: [
        { customerId: 'customer-1', displayName: 'Sarah', aliases: [], outstandingMinor: 1000 },
      ],
    });

    expect(next.activeProposal?.proposalId).toBe('proposal-1');
    expect(next.overlay).toMatchObject({
      status: 'clarification_required',
      reasonCode: 'AMBIGUOUS_CUSTOMER',
    });
  });
});
