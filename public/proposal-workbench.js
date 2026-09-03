export const PROPOSAL_ACTIVITY_LIMIT = 4;

const LEGACY_ACTIVITY_MESSAGE = '[object Object]';

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

function normalizeActivityMessage(message) {
  if (typeof message !== 'string') {
    return '';
  }

  const normalized = message.trim();
  if (!normalized || normalized === LEGACY_ACTIVITY_MESSAGE) {
    return '';
  }

  return normalized;
}

function normalizeActivityTimestamp(timestamp) {
  if (typeof timestamp === 'string' && timestamp.trim()) {
    return timestamp;
  }

  return new Date().toISOString();
}

export function createProposalActivityEntry(message) {
  const normalizedMessage = normalizeActivityMessage(message);
  if (!normalizedMessage) {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    message: normalizedMessage,
    kind: 'info',
  };
}

export function normalizeProposalActivityEntry(activity) {
  if (typeof activity === 'string') {
    return createProposalActivityEntry(activity);
  }

  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
    return null;
  }

  const normalizedMessage = normalizeActivityMessage(activity.message);
  if (!normalizedMessage) {
    return null;
  }

  return {
    timestamp: normalizeActivityTimestamp(activity.timestamp),
    message: normalizedMessage,
    kind: typeof activity.kind === 'string' && activity.kind.trim() ? activity.kind : 'info',
  };
}

export function normalizeProposalActivityLog(activity) {
  if (!Array.isArray(activity)) {
    return [];
  }

  return activity
    .map((entry) => normalizeProposalActivityEntry(entry))
    .filter((entry) => entry !== null)
    .slice(-PROPOSAL_ACTIVITY_LIMIT);
}

function describeProposalOperation(operation) {
  switch (operation) {
    case 'CREATE_OBLIGATION':
      return 'credit entry';
    case 'RECORD_PAYMENT':
      return 'payment';
    case 'SETTLE_OBLIGATION':
      return 'settlement';
    default:
      return 'ledger change';
  }
}

export function formatProposalActivityMessage(kind, operation = null) {
  const noun = describeProposalOperation(operation);

  switch (kind) {
    case 'summary':
      return 'Agent checked the ledger summary.';
    case 'search':
      return 'Agent searched customers.';
    case 'balance':
      return 'Agent checked a customer balance.';
    case 'history':
      return 'Agent reviewed customer history.';
    case 'overdue':
      return 'Agent checked overdue debts.';
    case 'prepare':
      return operation
        ? `Agent prepared a ${noun} for review.`
        : 'Agent prepared a ledger change for review.';
    case 'clarification':
      return operation
        ? `Agent found ambiguity while preparing a ${noun} and did not guess.`
        : 'Agent found ambiguity and did not guess.';
    case 'rejected':
      return operation
        ? `Agent tried a ${noun} that Talli rejected.`
        : 'Agent tried a ledger change that Talli rejected.';
    case 'confirm':
      return `You confirmed the ${noun}.`;
    case 'cancel':
      return operation ? `You cancelled the ${noun}.` : 'You cancelled the ledger change.';
    default:
      return 'Activity recorded.';
  }
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
        activeProposal: null,
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
        activeProposal: null,
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
  return normalizeProposalActivityLog([...(Array.isArray(activity) ? activity : []), entry]);
}

export function isProposalActionable(state) {
  return Boolean(
    state.activeProposal && state.activeProposal.status === 'pending' && !state.busyAction,
  );
}

export function formatConfirmStateMessage(response) {
  const operation = response?.proposal?.operation;
  switch (response.status) {
    case 'confirmed':
      return formatProposalActivityMessage('confirm', operation);
    case 'already_confirmed':
      return `This ${describeProposalOperation(operation)} was already confirmed.`;
    case 'cancelled':
      return formatProposalActivityMessage('cancel', operation);
    case 'already_cancelled':
      return `This ${describeProposalOperation(operation)} was already cancelled.`;
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
