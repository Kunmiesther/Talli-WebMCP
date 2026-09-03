export const PROPOSAL_ACTIVITY_LIMIT: number;

export interface ProposalView {
  proposalId: string;
  operation: string;
  summary: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
}

export interface ProposalWorkbenchState {
  activeProposal: ProposalView | null;
  overlay: {
    status: string;
    message: string;
    reasonCode?: string | null;
    candidates?: Array<{
      customerId: string;
      displayName: string;
      aliases?: string[];
      outstandingMinor?: number;
    }>;
    proposal?: ProposalView | null;
  } | null;
  busyAction: 'confirm' | 'cancel' | null;
  liveMessage: string;
  activity: Array<{
    timestamp: string;
    message: string;
    kind: string;
  }>;
}

export interface ProposalActivityEntry {
  timestamp: string;
  message: string;
  kind: string;
}

export function createProposalActivityEntry(message: string): ProposalActivityEntry | null;
export function normalizeProposalActivityEntry(activity: unknown): ProposalActivityEntry | null;
export function normalizeProposalActivityLog(activity: unknown): ProposalActivityEntry[];
export function formatProposalActivityMessage(kind: string, operation?: string | null): string;

export function createProposalWorkbenchState(): ProposalWorkbenchState;
export function withCurrentProposal(
  state: ProposalWorkbenchState,
  proposal: ProposalView | null | undefined,
): ProposalWorkbenchState;
export function withProposalOutcome(
  state: ProposalWorkbenchState,
  outcome: unknown,
): ProposalWorkbenchState;
export function beginProposalAction(
  state: ProposalWorkbenchState,
  action: 'confirm' | 'cancel',
): { state: ProposalWorkbenchState; started: boolean };
export function finishProposalAction(
  state: ProposalWorkbenchState,
  outcome: unknown,
): ProposalWorkbenchState;
export function appendProposalActivity(
  activity: ProposalWorkbenchState['activity'],
  entry: {
    timestamp?: string;
    message: string;
    kind?: string;
  },
): ProposalWorkbenchState['activity'];
export function isProposalActionable(state: ProposalWorkbenchState): boolean;
export function formatConfirmStateMessage(response: {
  status: string;
  message?: string;
  proposal?: ProposalView | null;
}): string;
