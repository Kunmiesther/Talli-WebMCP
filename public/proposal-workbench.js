export const PROPOSAL_ACTIVITY_LIMIT = 4;

function cloneProposal(proposal) {
  if (!proposal) {
    return null;
  }

  return {
    ...proposal,
    candidates: Array.isArray(proposal.candidates)
      ? proposal.candidates.map((candidate) => ({ ...candidate }))
      : undefined,
  };
}

function cloneOverlay(overlay) {
  if (!overlay) {
    return null;
  }

  return {
    ...overlay,
    candidates: Array.isArray(overlay.candidates)
      ? overlay.candidates.map((candidate) => ({ ...candidate }))
      : undefined,
  };
}

function normalizeActivity(activity) {
  return {
    timestamp: activity.timestamp ?? new Date().toISOString(),
    message: String(activity.message ?? '').trim(),
    kind: activity.kind ?? 'info',
  };
}

export function createProposalWorkbenchState() {
  return {
    activeProposal: null,
    overlay: null,
    busyAction: null,
    liveMessage: '',
    activity: [],
  };
}

export function withCurrentProposal(state, proposal) {
  return {
    ...state,
    activeProposal: cloneProposal(proposal),
    overlay: null,
    busyAction: null,
    liveMessage: proposal
      ? 'Agent prepared a ledger change. The ledger has not changed yet.'
      : state.liveMessage,
  };
}

export function withProposalOverlay(state, overlay) {
  return {
    ...state,
    overlay: cloneOverlay(overlay),
    busyAction: null,
    liveMessage: overlay?.message ?? state.liveMessage,
  };
}

export function withProposalOutcome(state, outcome) {
  switch (outcome.status) {
    case 'confirmation_required':
      return withCurrentProposal(state, outcome.proposal);
    case 'clarification_required':
      return {
        ...state,
        overlay: {
          status: 'clarification_required',
          message: outcome.message,
          reasonCode: outcome.reasonCode,
          candidates: outcome.candidates?.map((candidate) => ({ ...candidate })) ?? [],
        },
        busyAction: null,
        liveMessage: outcome.message,
      };
    case 'rejected':
      return {
        ...state,
        overlay: {
          status: 'rejected',
          message: outcome.message,
          reasonCode: outcome.reasonCode,
        },
        busyAction: null,
        liveMessage: outcome.message,
      };
    case 'confirmed':
    case 'already_confirmed':
      return {
        ...state,
        activeProposal: null,
        overlay: {
          status: outcome.status,
          message: outcome.message,
          proposal: cloneProposal(outcome.proposal),
        },
        busyAction: null,
        liveMessage: outcome.message,
      };
    case 'cancelled':
    case 'already_cancelled':
    case 'expired':
    case 'stale':
      return {
        ...state,
        activeProposal: null,
        overlay: {
          status: outcome.status,
          message: outcome.message,
          reasonCode: outcome.reasonCode ?? null,
          proposal: cloneProposal(outcome.proposal),
        },
        busyAction: null,
        liveMessage: outcome.message,
      };
    case 'error':
      return {
        ...state,
        overlay: {
          status: 'error',
          message: outcome.message,
          reasonCode: outcome.reasonCode ?? null,
        },
        busyAction: null,
        liveMessage: outcome.message,
      };
    default:
      return state;
  }
}

export function beginProposalAction(state, action) {
  if (state.busyAction || !state.activeProposal) {
    return {
      state,
      started: false,
    };
  }

  if (state.activeProposal.status !== 'pending') {
    return {
      state,
      started: false,
    };
  }

  return {
    state: {
      ...state,
      busyAction: action,
      liveMessage:
        action === 'confirm'
          ? 'Confirming the proposal.'
          : action === 'cancel'
            ? 'Cancelling the proposal.'
            : state.liveMessage,
    },
    started: true,
  };
}

export function finishProposalAction(state, outcome) {
  const next = withProposalOutcome(
    {
      ...state,
      busyAction: null,
    },
    outcome,
  );

  if (outcome.status === 'confirmed' || outcome.status === 'already_confirmed') {
    return {
      ...next,
      activeProposal: null,
    };
  }

  if (
    outcome.status === 'cancelled' ||
    outcome.status === 'already_cancelled' ||
    outcome.status === 'expired' ||
    outcome.status === 'stale' ||
    outcome.status === 'rejected'
  ) {
    return {
      ...next,
      activeProposal: null,
    };
  }

  return next;
}

export function appendProposalActivity(activity, entry) {
  const normalized = normalizeActivity(entry);
  const next = [...activity, normalized];
  return next.slice(-PROPOSAL_ACTIVITY_LIMIT);
}

export function isProposalActionable(state) {
  return Boolean(
    state.activeProposal && state.activeProposal.status === 'pending' && !state.busyAction,
  );
}

export function formatConfirmStateMessage(response) {
  switch (response.status) {
    case 'confirmed':
      return `You confirmed: ${response.proposal?.summary ?? 'the proposal'}.`;
    case 'already_confirmed':
      return 'This proposal was already confirmed.';
    case 'cancelled':
      return 'Proposal cancelled.';
    case 'already_cancelled':
      return 'This proposal was already cancelled.';
    case 'expired':
      return 'This proposal expired before it could be confirmed.';
    case 'stale':
      return 'The ledger changed before confirmation.';
    case 'rejected':
      return response.message;
    default:
      return response.message ?? 'Nothing changed.';
  }
}
