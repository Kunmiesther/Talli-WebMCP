import { describe, expect, it } from 'vitest';
import {
  appendProposalActivity,
  beginProposalAction,
  createProposalWorkbenchState,
  finishProposalAction,
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
