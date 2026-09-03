import {
  appendProposalActivity,
  beginProposalAction,
  createProposalActivityEntry,
  createProposalWorkbenchState,
  finishProposalAction,
  formatConfirmStateMessage,
  formatProposalActivityMessage,
  normalizeProposalActivityLog,
  withCurrentProposal,
  withProposalOutcome,
} from './proposal-workbench.js';
import { handleTelegramLinkFailure, handleTelegramLinkResponse } from './telegram-link.js';
import { abortTalliWebMcpTools, registerTalliWebMcpTools } from './webmcp-tools.js';

const DEMO_SESSION_ID = 'default';
const TIMEZONE = 'Africa/Lagos';
const STORAGE_KEYS = {
  conversation: 'talli:conversation',
  selectedCustomer: 'talli:selectedCustomer',
  collaboration: 'talli:collaboration',
};

const DEFAULT_WORKSPACE_NOTE =
  'Send a voice note or type an update. Talli asks before it changes anything unclear.';

const SAFE_FAILURE_NOTICE =
  "Talli couldn't process that update right now. Nothing was changed. Please try again.";

const API_REQUEST_TIMEOUT_MS = 30_000;
const API_TIMEOUT_NOTICE =
  'Talli timed out while updating your ledger. Nothing was changed. Please try again.';

const dateFormatter = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const longDateFormatter = new Intl.DateTimeFormat('en-NG', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const dom = {};

const state = {
  loading: true,
  sending: false,
  listening: false,
  health: null,
  ledger: null,
  account: {
    connected: false,
    userId: null,
    telegramUsername: null,
    preferredCurrency: 'NGN',
    linkToken: null,
    linkTokenStatus: 'idle',
    deepLink: null,
  },
  customerDetails: new Map(),
  selectedCustomerId: loadStoredJson(STORAGE_KEYS.selectedCustomer, null),
  conversation: loadStoredJson(STORAGE_KEYS.conversation, []),
  clarification: null,
  proposalPanel: {
    ...createProposalWorkbenchState(),
    activity: loadStoredJson(STORAGE_KEYS.collaboration, [], normalizeProposalActivityLog),
  },
  transcriptPreview: '',
  pendingSubmission: null,
  telegramDisconnectOpen: false,
  voiceSupport: {
    supported: false,
    note: 'Tap the mic and tell Talli what happened.',
    status: 'ready',
  },
  notice: '',
};

let recognition = null;
let finalTranscript = '';
let interimTranscript = '';

function loadStoredJson(key, fallback, normalize = (value) => value) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return normalize(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function saveStoredJson(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    void 0;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoney(minorUnits) {
  if (typeof minorUnits !== 'number' || Number.isNaN(minorUnits)) {
    const currency = state.ledger?.currency ?? 'NGN';
    const locale = currency === 'NGN' ? 'en-NG' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(0);
  }
  const currency = state.ledger?.currency ?? 'NGN';
  const locale = currency === 'NGN' ? 'en-NG' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}

function formatDate(value) {
  if (!value) {
    return 'No due date';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No due date';
  }
  return dateFormatter.format(date);
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return dateTimeFormatter.format(date);
}

function formatLongDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return longDateFormatter.format(date);
}

function detectLanguage(text) {
  return /\b(don|wey|na|carry|dey|dem|im|una|fit|oo|eh|sha)\b/i.test(text) ? 'pcm' : 'en';
}

function isConnectedAccount() {
  return Boolean(state.account?.connected);
}

function telegramConnectionButtons() {
  const buttons = [];
  if (dom.connectTelegramButton) {
    buttons.push(dom.connectTelegramButton);
  }
  for (const button of dom.connectTelegramCtas ?? []) {
    if (button) {
      buttons.push(button);
    }
  }
  return buttons;
}

function statusLabel(status) {
  switch (status) {
    case 'pending':
      return 'Processing';
    case 'applied':
      return 'Recorded';
    case 'clarification_required':
      return 'Clarification';
    case 'no_action':
      return 'No action';
    case 'error':
      return 'No change';
    default:
      return 'Update';
  }
}

function statusIcon(status) {
  switch (status) {
    case 'pending':
      return 'fa-spinner fa-spin';
    case 'applied':
      return 'fa-circle-check';
    case 'clarification_required':
      return 'fa-shield-halved';
    case 'no_action':
      return 'fa-circle-info';
    case 'error':
      return 'fa-triangle-exclamation';
    default:
      return 'fa-comment-dots';
  }
}

function actionLabel(actionType) {
  switch (actionType) {
    case 'CREATE_OBLIGATION':
      return 'Credit sale';
    case 'RECORD_PAYMENT':
      return 'Payment';
    case 'CORRECT_OBLIGATION':
      return 'Correction';
    case 'SETTLE_OBLIGATION':
      return 'Settlement';
    case 'REQUEST_CLARIFICATION':
      return 'Clarification';
    case 'NO_ACTION':
      return 'No action';
    default:
      return 'Update';
  }
}

function responseSummary(response) {
  if (!response) {
    return '';
  }

  if (response.status === 'error') {
    return response.message || 'Nothing was changed.';
  }

  if (response.status === 'clarification_required' && response.clarification) {
    const candidates = response.clarification.candidates
      .map((candidate) => candidate.displayName)
      .join(', ');
    return candidates ? `${response.message} Candidates: ${candidates}.` : response.message;
  }

  if (response.ledgerChange?.customerName) {
    const amount =
      typeof response.ledgerChange.outstandingMinor === 'number'
        ? formatMoney(response.ledgerChange.outstandingMinor)
        : null;
    if (amount) {
      return `${response.message} ${response.ledgerChange.customerName} balance: ${amount}.`;
    }
  }

  return response.message;
}

function renderMetricCard(label, value, note) {
  return `
    <article class="metric">
      <span class="metric__label">${escapeHtml(label)}</span>
      <span class="metric__value">${escapeHtml(value)}</span>
      <span class="metric__note">${escapeHtml(note)}</span>
    </article>
  `;
}

function computeCustomerSummary(customerId) {
  const detail = state.customerDetails.get(customerId);
  const obligations = detail?.obligations ?? [];
  const open = obligations.filter((obligation) => obligation.status === 'open');
  const settled = obligations.filter((obligation) => obligation.status === 'settled');
  const outstandingMinor = open.reduce((sum, obligation) => sum + obligation.outstandingMinor, 0);
  const nextDue =
    open
      .map((obligation) => obligation.dueAt)
      .filter(Boolean)
      .sort((left, right) => String(left).localeCompare(String(right)))[0] ?? null;

  return {
    open,
    settled,
    outstandingMinor,
    nextDue,
  };
}

function aggregatePaymentCount() {
  let count = 0;
  for (const detail of state.customerDetails.values()) {
    for (const event of detail.events ?? []) {
      if (event.kind === 'payment.recorded') {
        count += 1;
      }
    }
  }
  return count;
}

function customerSummaryObligationCount(customerId) {
  const detail = state.customerDetails.get(customerId);
  return detail?.obligations?.length ?? 0;
}

function renderMetrics() {
  const ledger = state.ledger;
  if (!ledger) {
    dom.metricsGrid.innerHTML = `
      ${renderMetricCard('Total outstanding', formatMoney(0), 'Waiting for the ledger')}
      ${renderMetricCard('Customers owing', '0', 'No customer loaded yet')}
      ${renderMetricCard('Settled debts', '0', 'Closed obligations will appear here')}
      ${renderMetricCard('Payments recorded', '0', 'Derived from customer histories')}
    `;
    dom.ledgerCount.textContent = '0 customers';
    dom.customerCount.textContent = '0 owing';
    return;
  }

  const owingCustomers = ledger.customers.filter(
    (customer) => computeCustomerSummary(customer.id).outstandingMinor > 0,
  ).length;
  const paymentCount = aggregatePaymentCount();
  const settledDebts = ledger.obligations.filter(
    (obligation) => obligation.status === 'settled',
  ).length;

  dom.metricsGrid.innerHTML = `
    ${renderMetricCard(
      'Total outstanding',
      formatMoney(ledger.totals.openOutstandingMinor),
      `${ledger.obligations.length} obligations tracked`,
    )}
    ${renderMetricCard('Customers owing', String(owingCustomers), 'Customers with open balances')}
    ${renderMetricCard('Settled debts', String(settledDebts), 'Closed obligations in history')}
    ${renderMetricCard('Payments recorded', String(paymentCount), 'Derived from customer histories')}
  `;

  dom.ledgerCount.textContent = `${ledger.customers.length} customers`;
  dom.customerCount.textContent = `${owingCustomers} owing`;
}

function renderCustomerList() {
  const ledger = state.ledger;
  if (!ledger || ledger.customers.length === 0) {
    dom.customerList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-users"></i>
        <p>No credit records yet. Tell Talli about your first credit sale to get started.</p>
      </div>
    `;
    return;
  }

  const customers = [...ledger.customers].sort((left, right) => {
    const leftSummary = computeCustomerSummary(left.id);
    const rightSummary = computeCustomerSummary(right.id);
    const balanceDelta = rightSummary.outstandingMinor - leftSummary.outstandingMinor;
    if (balanceDelta !== 0) {
      return balanceDelta;
    }
    return left.displayName.localeCompare(right.displayName);
  });

  dom.customerList.innerHTML = customers
    .map((customer) => {
      const summary = computeCustomerSummary(customer.id);
      const selected = customer.id === state.selectedCustomerId ? ' customer-row--selected' : '';
      const statusText = summary.outstandingMinor > 0 ? 'Open balance' : 'Settled';
      const dueText = summary.nextDue
        ? `Due ${formatDate(summary.nextDue)}`
        : summary.outstandingMinor > 0
          ? 'No due date'
          : 'Closed';
      const balance =
        summary.outstandingMinor > 0 ? formatMoney(summary.outstandingMinor) : 'Settled';
      const aliasText = customer.aliases?.length
        ? `${customer.aliases.length} alias${customer.aliases.length === 1 ? '' : 'es'}`
        : `${customerSummaryObligationCount(customer.id)} obligation${
            customerSummaryObligationCount(customer.id) === 1 ? '' : 's'
          }`;
      return `
        <button
          class="customer-row${selected}"
          type="button"
          data-customer-id="${escapeHtml(customer.id)}"
          aria-pressed="${customer.id === state.selectedCustomerId ? 'true' : 'false'}"
        >
          <span class="customer-row__name">${escapeHtml(customer.displayName)}</span>
          <span class="customer-row__balance">${escapeHtml(balance)}</span>
          <span class="customer-row__status">${escapeHtml(statusText)} · ${escapeHtml(aliasText)}</span>
          <span class="customer-row__due">${escapeHtml(dueText)}</span>
        </button>
      `;
    })
    .join('');
}

function renderPendingTurn() {
  if (!state.pendingSubmission) {
    return '';
  }

  return `
    <article class="turn card turn--pending">
      <div class="turn__meta">
        <span class="turn__badge">
          <i class="fa-solid fa-spinner fa-spin"></i>
          Processing
          · Update
        </span>
        <time class="turn__time">${escapeHtml(formatDateTime(state.pendingSubmission.timestamp))}</time>
      </div>
      <p class="turn__input">${escapeHtml(state.pendingSubmission.text)}</p>
      <div class="turn__response">
        <p>Updating your ledger&hellip;</p>
      </div>
    </article>
  `;
}

function renderActivityFeed() {
  const items = state.conversation;
  const visibleCount = items.length + (state.pendingSubmission ? 1 : 0);
  dom.turnCount.textContent = `${visibleCount} turn${visibleCount === 1 ? '' : 's'}`;

  if (visibleCount === 0) {
    dom.activityFeed.innerHTML = '';
    dom.activityEmpty.hidden = false;
    return;
  }

  dom.activityEmpty.hidden = true;
  dom.activityFeed.innerHTML = `${renderPendingTurn()}${items
    .map((item) => {
      const response = item.response;
      const responseHtml = renderResponseBlock(response);
      const statusClass = `turn--${response.status}`;
      return `
        <article class="turn card ${statusClass}">
          <div class="turn__meta">
            <span class="turn__badge">
              <i class="fa-solid ${statusIcon(response.status)}"></i>
              ${escapeHtml(statusLabel(response.status))}
              · ${escapeHtml(actionLabel(response.action?.type))}
            </span>
            <time class="turn__time">${escapeHtml(formatDateTime(item.timestamp))}</time>
          </div>
          <p class="turn__input">${escapeHtml(item.text)}</p>
          <div class="turn__response">${responseHtml}</div>
        </article>
      `;
    })
    .join('')}`;
}

function renderResponseBlock(response) {
  const summary = escapeHtml(responseSummary(response));
  const extra = [];

  if (response.status === 'clarification_required' && response.clarification?.candidates?.length) {
    extra.push(
      `<div class="turn-chip">
        <span class="turn-chip__label">Candidates</span>
        <span class="turn-chip__copy">${escapeHtml(
          response.clarification.candidates.map((candidate) => candidate.displayName).join(', '),
        )}</span>
      </div>`,
    );
  }

  if (response.ledgerChange?.customerName) {
    const outstanding =
      typeof response.ledgerChange.outstandingMinor === 'number'
        ? formatMoney(response.ledgerChange.outstandingMinor)
        : 'Updated';
    extra.push(
      `<div class="turn-chip">
        <span class="turn-chip__label">Ledger update</span>
        <span class="turn-chip__copy">${escapeHtml(response.ledgerChange.customerName)} · ${escapeHtml(outstanding)}</span>
      </div>`,
    );
  }

  if (response.status === 'error') {
    extra.push(
      `<div class="turn-chip">
        <span class="turn-chip__label">Outcome</span>
        <span class="turn-chip__copy">Nothing changed.</span>
      </div>`,
    );
  }

  const extraMarkup = extra.length ? `<div class="turn-list">${extra.join('')}</div>` : '';
  return `<p>${summary}</p>${extraMarkup}`;
}

function renderClarification() {
  if (!state.clarification) {
    dom.clarificationPanel.hidden = true;
    dom.clarificationQuestion.textContent = '';
    dom.clarificationCandidates.innerHTML = '';
    dom.clarificationTitle.textContent = 'Talli needs one safe answer';
    return;
  }

  dom.clarificationPanel.hidden = false;
  dom.clarificationTitle.textContent = 'Clarification required';
  dom.clarificationQuestion.textContent = state.clarification.response.message;
  const candidates = state.clarification.response.clarification?.candidates ?? [];
  dom.clarificationCandidates.innerHTML = candidates
    .map((candidate) => {
      const kindLabel = candidate.kind === 'obligation' ? 'Debt' : 'Customer';
      const suggestion = buildCandidateSuggestion(candidate);
      return `
        <button class="candidate" type="button" data-candidate-suggestion="${escapeHtml(suggestion)}">
          <strong class="candidate__title">${escapeHtml(candidate.displayName)}</strong>
          <span class="candidate__detail">${escapeHtml(kindLabel)} · tap to fill a safe follow-up</span>
        </button>
      `;
    })
    .join('');
}

function buildCandidateSuggestion(candidate) {
  if (candidate.kind === 'obligation') {
    return `The one with ${candidate.displayName}.`;
  }

  if (candidate.displayName.toLowerCase().includes('musa')) {
    return `The first ${candidate.displayName}.`;
  }

  return `I mean ${candidate.displayName}.`;
}

function renderCustomerDetail() {
  const customerId = state.selectedCustomerId;
  const ledger = state.ledger;
  const detail = customerId ? state.customerDetails.get(customerId) : null;

  if (!ledger || !detail || !detail.customer) {
    dom.detailTitle.textContent = 'Select a customer';
    dom.detailStatus.textContent = 'Waiting';
    dom.customerDetail.innerHTML = `
      <div class="empty-state empty-state--detail">
        <i class="fa-solid fa-user-tag"></i>
        <p>Choose a customer to see what they owe, what they paid, and the notes behind it.</p>
      </div>
    `;
    return;
  }

  const customer = detail.customer;
  const summary = computeCustomerSummary(customer.id);
  const openObligations = [...summary.open].sort((left, right) => {
    const leftDue = left.dueAt ?? left.createdAt;
    const rightDue = right.dueAt ?? right.createdAt;
    return String(leftDue).localeCompare(String(rightDue));
  });
  const settledObligations = [...summary.settled].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const events = [...(detail.events ?? [])].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const recentTurns = [...(detail.recentTurns ?? [])].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const totalPaidMinor = detail.obligations.reduce(
    (sum, obligation) => sum + obligation.totalPaidMinor,
    0,
  );
  const lastUpdated = events.at(-1)?.timestamp ?? customer.updatedAt;

  dom.detailTitle.textContent = customer.displayName;
  dom.detailStatus.textContent = summary.outstandingMinor > 0 ? 'Open' : 'Settled';

  dom.customerDetail.innerHTML = `
    <div class="detail-hero">
      <div>
        <h4>${escapeHtml(customer.displayName)}</h4>
        <div class="detail-hero__meta">
          <span>${escapeHtml(
            customer.aliases?.length
              ? `${customer.aliases.length} alias${customer.aliases.length === 1 ? '' : 'es'}`
              : 'No aliases recorded',
          )}</span>
          <span>Updated ${escapeHtml(formatLongDate(lastUpdated) || 'recently')}</span>
        </div>
      </div>
      <span class="status-pill ${summary.outstandingMinor > 0 ? 'status-pill--warning' : ''}">
        <i class="fa-solid ${summary.outstandingMinor > 0 ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i>
        ${escapeHtml(
          summary.outstandingMinor > 0
            ? `${formatMoney(summary.outstandingMinor)} outstanding`
            : 'Settled',
        )}
      </span>
    </div>

    <div class="detail-stats">
      <div class="detail-stat">
        <span class="detail-stat__label">Open obligations</span>
        <span class="detail-stat__value">${escapeHtml(String(openObligations.length))}</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat__label">Settled obligations</span>
        <span class="detail-stat__value">${escapeHtml(String(settledObligations.length))}</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat__label">Total paid</span>
        <span class="detail-stat__value">${escapeHtml(formatMoney(totalPaidMinor))}</span>
      </div>
    </div>

    <div class="detail-sections">
      <section class="detail-section">
        <h5>Open obligations</h5>
        <div class="obligation-list">
          ${
            openObligations.length
              ? openObligations.map(renderObligationItem).join('')
              : `<div class="empty-state"><i class="fa-solid fa-circle-check"></i><p>No open balances.</p></div>`
          }
        </div>
      </section>

      <section class="detail-section">
        <h5>Settled obligations</h5>
        <div class="obligation-list">
          ${
            settledObligations.length
              ? settledObligations.map(renderObligationItem).join('')
              : `<div class="empty-state"><i class="fa-solid fa-circle-check"></i><p>No settled balances yet.</p></div>`
          }
        </div>
      </section>

      <section class="detail-section">
        <h5>Timeline</h5>
        <div class="event-list">
          ${
            events.length
              ? events.map(renderEventItem).join('')
              : `<div class="empty-state"><i class="fa-solid fa-clock"></i><p>No notes yet.</p></div>`
          }
        </div>
      </section>

      <section class="detail-section">
        <h5>Recent turns</h5>
        <div class="turn-list">
          ${
            recentTurns.length
              ? recentTurns.map(renderTurnChip).join('')
              : `<div class="empty-state"><i class="fa-solid fa-comment-dots"></i><p>No recent updates for this customer.</p></div>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderObligationItem(obligation) {
  const title = `${formatMoney(obligation.originalAmountMinor)} original`;
  const balance =
    obligation.status === 'settled'
      ? 'Settled'
      : `${formatMoney(obligation.outstandingMinor)} remaining`;
  const meta = [
    obligation.dueAt ? `Due ${formatDate(obligation.dueAt)}` : 'No due date',
    `${formatMoney(obligation.totalPaidMinor)} paid`,
  ].join(' · ');

  return `
    <article class="obligation-item">
      <div>
        <div class="obligation-item__title">${escapeHtml(title)}</div>
        <div class="obligation-item__meta">${escapeHtml(meta)}</div>
      </div>
      <div class="obligation-item__status">${escapeHtml(balance)}</div>
    </article>
  `;
}

function renderEventItem(event) {
  const title = eventTitle(event);
  const copy = eventCopy(event);
  return `
    <article class="event-item">
      <div class="event-item__title">${escapeHtml(title)}</div>
      <div class="event-item__copy">${escapeHtml(copy)}</div>
    </article>
  `;
}

function eventTitle(event) {
  switch (event.kind) {
    case 'customer.created':
      return 'Customer recorded';
    case 'obligation.created':
      return `Debt opened for ${formatMoney(event.originalAmountMinor)}`;
    case 'payment.recorded':
      return `Payment of ${formatMoney(event.amountMinor)} recorded`;
    case 'obligation.corrected':
      return `Correction from ${formatMoney(event.previousAmountMinor)} to ${formatMoney(event.correctedAmountMinor)}`;
    case 'decision.clarification_requested':
      return 'Clarification requested';
    case 'decision.no_action':
      return 'No action recorded';
    default:
      return 'Event';
  }
}

function eventCopy(event) {
  switch (event.kind) {
    case 'customer.created':
      return `${event.displayName} added on ${formatDateTime(event.timestamp)}.`;
    case 'obligation.created':
      return `${formatMoney(event.originalAmountMinor)} opened${event.dueAt ? ` · due ${formatDate(event.dueAt)}` : ''}.`;
    case 'payment.recorded':
      return `${formatMoney(event.amountMinor)} moved from ${formatMoney(event.outstandingBeforeMinor)} to ${formatMoney(event.outstandingAfterMinor)} outstanding.`;
    case 'obligation.corrected':
      return `${formatMoney(event.previousAmountMinor)} corrected to ${formatMoney(event.correctedAmountMinor)}. Outstanding changed from ${formatMoney(event.previousOutstandingMinor)} to ${formatMoney(event.correctedOutstandingMinor)}.`;
    case 'decision.clarification_requested':
      return event.question;
    case 'decision.no_action':
      return event.reason ?? 'No action was taken.';
    default:
      return 'Recorded in the audit trail.';
  }
}

function renderTurnChip(turn) {
  return `
    <article class="turn-chip">
      <span class="turn-chip__label">${escapeHtml(turn.status.replaceAll('_', ' '))}</span>
      <span class="turn-chip__copy">${escapeHtml(turn.inputText)}</span>
      <span class="turn-chip__label">${escapeHtml(formatDateTime(turn.timestamp))}</span>
    </article>
  `;
}

function renderComposerState() {
  const voiceNote = dom.voiceSupportNote;
  const stateChip = dom.composerState;
  const transcript = dom.transcriptPreview;
  const mic = dom.micToggle;
  const micLabel = dom.micLabel;
  const voicePrompt = dom.voicePrompt;
  const sendLabel = dom.sendLabel;
  const sendDisabled = state.sending || state.listening || !dom.composerInput.value.trim();

  if (state.pendingSubmission) {
    voicePrompt.textContent = 'Updating your ledger...';
    voiceNote.textContent = 'Please wait while Talli records this update.';
    mic.dataset.state = 'pending';
    stateChip.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating your ledger...';
  } else if (!state.voiceSupport.supported) {
    voicePrompt.textContent = 'Speak here';
    voiceNote.textContent = state.voiceSupport.note;
    mic.dataset.state = 'unsupported';
    stateChip.innerHTML = '<i class="fa-solid fa-circle-info"></i> Ready to record';
  } else if (state.listening) {
    voicePrompt.textContent = 'Listening...';
    voiceNote.textContent = 'Speak naturally. Talli will fill the box below.';
    mic.dataset.state = 'listening';
    stateChip.innerHTML = '<i class="fa-solid fa-wave-square"></i> Listening...';
  } else if (state.voiceSupport.status === 'error') {
    voicePrompt.textContent = 'Speak here';
    voiceNote.textContent = state.voiceSupport.note;
    mic.dataset.state = 'error';
    stateChip.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Speak here';
  } else {
    voicePrompt.textContent = 'Speak here';
    voiceNote.textContent = state.voiceSupport.note;
    mic.dataset.state = 'ready';
    if (state.transcriptPreview) {
      stateChip.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Transcript ready';
    } else if (state.clarification) {
      stateChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Clarification waiting';
    } else {
      stateChip.innerHTML = '<i class="fa-solid fa-circle-info"></i> Speak here';
    }
  }

  transcript.textContent =
    state.transcriptPreview ||
    (state.listening ? 'Listening...' : 'Your speech will appear here before you send it.');
  mic.setAttribute('aria-pressed', String(state.listening));
  mic.setAttribute('aria-label', state.listening ? 'Stop listening' : 'Start voice input');
  mic.setAttribute('title', state.listening ? 'Stop listening' : 'Start voice input');
  micLabel.textContent = state.listening ? 'Stop voice input' : 'Voice input';
  sendLabel.textContent = state.sending ? 'Sending...' : 'Send';
  dom.sendMessage.setAttribute('aria-busy', String(state.sending));
  dom.sendMessage.disabled = sendDisabled;
  dom.micToggle.disabled = state.sending || !state.voiceSupport.supported;
}

function renderNotice() {
  dom.workspaceNote.textContent = state.notice || DEFAULT_WORKSPACE_NOTE;
}

function renderProposalReview() {
  if (
    !dom.proposalPanel ||
    !dom.proposalHeadline ||
    !dom.proposalStatus ||
    !dom.proposalSummary ||
    !dom.proposalMessage ||
    !dom.proposalOperation ||
    !dom.proposalExpires ||
    !dom.proposalCandidates ||
    !dom.proposalConfirm ||
    !dom.proposalCancel ||
    !dom.proposalLive
  ) {
    return;
  }

  const proposal = state.proposalPanel.activeProposal;
  const overlay = state.proposalPanel.overlay;
  const hasProposal = Boolean(proposal);
  const hasOverlay = Boolean(overlay);

  dom.proposalPanel.hidden = !hasProposal && !hasOverlay;
  if (!hasProposal && !hasOverlay) {
    dom.proposalHeadline.textContent = 'Agent prepared a ledger change';
    dom.proposalStatus.textContent = 'Waiting for review';
    dom.proposalSummary.textContent = '';
    dom.proposalMessage.textContent = '';
    dom.proposalOperation.textContent = '';
    dom.proposalExpires.textContent = '';
    dom.proposalCandidates.innerHTML = '';
    dom.proposalConfirm.hidden = false;
    dom.proposalCancel.hidden = false;
    dom.proposalConfirm.disabled = false;
    dom.proposalCancel.disabled = false;
    dom.proposalLive.textContent = '';
    return;
  }

  const overlayStatus = overlay?.status ?? null;
  const activeTitle =
    overlayStatus === 'clarification_required'
      ? 'Clarification required'
      : overlayStatus === 'rejected'
        ? 'Could not prepare a ledger change'
        : overlayStatus === 'confirmed' || overlayStatus === 'already_confirmed'
          ? 'Ledger change confirmed'
          : overlayStatus === 'cancelled' || overlayStatus === 'already_cancelled'
            ? 'Proposal cancelled'
            : overlayStatus === 'expired'
              ? 'Proposal expired'
              : overlayStatus === 'stale'
                ? 'Proposal became stale'
                : 'Agent prepared a ledger change';

  dom.proposalHeadline.textContent = activeTitle;
  dom.proposalStatus.textContent =
    overlayStatus === 'clarification_required'
      ? 'No mutation yet'
      : overlayStatus === 'rejected'
        ? 'No change'
        : overlayStatus === 'confirmed' || overlayStatus === 'already_confirmed'
          ? 'Confirmed by you'
          : overlayStatus === 'cancelled' || overlayStatus === 'already_cancelled'
            ? 'Cancelled'
            : overlayStatus === 'expired'
              ? 'Expired'
              : overlayStatus === 'stale'
                ? 'Stale'
                : hasProposal
                  ? 'Awaiting your decision'
                  : 'Review';

  dom.proposalSummary.textContent =
    proposal?.summary ??
    overlay?.message ??
    'Talli is showing the safe result of the latest browser-agent action.';

  dom.proposalMessage.textContent =
    overlayStatus === 'clarification_required'
      ? 'Talli did not guess. No ledger change occurred.'
      : overlayStatus === 'rejected'
        ? (overlay?.message ?? 'No ledger change occurred.')
        : hasProposal
          ? 'The ledger has not changed yet.'
          : (overlay?.message ?? '');

  dom.proposalOperation.textContent = proposal ? actionLabel(proposal.operation) : '';
  dom.proposalExpires.textContent = proposal?.expiresAt
    ? `Expires ${formatDateTime(proposal.expiresAt)}`
    : '';

  dom.proposalCandidates.innerHTML = '';
  if (overlayStatus === 'clarification_required' && overlay?.candidates?.length) {
    dom.proposalCandidates.innerHTML = overlay.candidates
      .map((candidate) => {
        const details = [];
        if (candidate.aliases?.length) {
          details.push(candidate.aliases.join(', '));
        }
        if (typeof candidate.outstandingMinor === 'number') {
          details.push(formatMoney(candidate.outstandingMinor));
        }
        return `
          <div class="proposal-candidate">
            <strong>${escapeHtml(candidate.displayName)}</strong>
            <span>${escapeHtml(details.length ? details.join(' · ') : 'Possible match')}</span>
          </div>
        `;
      })
      .join('');
  }

  const actionable = Boolean(proposal && proposal.status === 'pending');
  const busy = state.proposalPanel.busyAction !== null;
  dom.proposalConfirm.hidden = !actionable;
  dom.proposalCancel.hidden = !actionable;
  dom.proposalConfirm.disabled = !actionable || busy;
  dom.proposalCancel.disabled = !actionable || busy;
  dom.proposalConfirm.textContent =
    busy && state.proposalPanel.busyAction === 'confirm' ? 'Confirming...' : 'Confirm';
  dom.proposalCancel.textContent =
    busy && state.proposalPanel.busyAction === 'cancel' ? 'Cancelling...' : 'Cancel';
  dom.proposalLive.textContent = state.proposalPanel.liveMessage || dom.proposalMessage.textContent;
}

function renderCollaborationActivity() {
  if (!dom.collaborationFeed || !dom.collaborationEmpty || !dom.collaborationCount) {
    return;
  }

  const items = state.proposalPanel.activity ?? [];
  dom.collaborationCount.textContent = `${items.length} update${items.length === 1 ? '' : 's'}`;
  if (items.length === 0) {
    dom.collaborationFeed.innerHTML = '';
    dom.collaborationEmpty.hidden = false;
    return;
  }

  dom.collaborationEmpty.hidden = true;
  dom.collaborationFeed.innerHTML = items
    .slice(-4)
    .map(
      (item) => `
        <article class="activity-item">
          <span class="activity-item__copy">${escapeHtml(item.message)}</span>
          <time class="activity-item__time">${escapeHtml(formatDateTime(item.timestamp))}</time>
        </article>
      `,
    )
    .join('');
}

function renderAccountCard() {
  if (!dom.accountStatus || !dom.connectTelegramButton || !dom.telegramLink) {
    return;
  }

  if (state.account.connected) {
    const username = state.account.telegramUsername?.replace(/^@+/, '').trim();
    const displayName = username ? `@${username}` : 'Telegram';
    dom.accountStatus.textContent = `Connected to Telegram as ${displayName}.`;
    dom.telegramLink.hidden = true;
  } else {
    dom.accountStatus.textContent = state.account.deepLink
      ? "If Telegram doesn't open, click Open Talli in Telegram."
      : 'Connect Telegram to use the same ledger in chat and on the web.';
    if (state.account.deepLink) {
      dom.telegramLink.hidden = false;
      dom.telegramLink.href = state.account.deepLink;
      dom.telegramLink.textContent = 'Open Talli in Telegram';
    } else {
      dom.telegramLink.hidden = true;
    }
  }

  for (const button of telegramConnectionButtons()) {
    if (state.account.connected) {
      button.dataset.connectionState = 'connected';
      button.disabled = false;
      button.removeAttribute('aria-disabled');
      button.title = 'Disconnect Telegram';
      button.innerHTML =
        '<i class="fa-solid fa-circle-check"></i><span>Connected to Telegram</span>';
      continue;
    }

    if (state.account.linkTokenStatus === 'pending') {
      button.dataset.connectionState = 'pending';
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.removeAttribute('title');
      button.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i><span>Opening Telegram...</span>';
      continue;
    }

    button.dataset.connectionState = 'idle';
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.removeAttribute('title');
    button.innerHTML = '<span>Connect Telegram</span>';
  }
}

function renderTelegramDisconnectModal() {
  if (!dom.telegramDisconnectModal) {
    return;
  }

  const connected = state.account.connected;
  const open = connected && state.telegramDisconnectOpen;
  dom.telegramDisconnectModal.hidden = !open;
  dom.telegramDisconnectModal.setAttribute('aria-hidden', String(!open));

  if (!open) {
    return;
  }

  const username = state.account.telegramUsername?.replace(/^@+/, '').trim();
  const displayName = username ? `@${username}` : 'this Telegram account';
  if (dom.telegramDisconnectCopy) {
    dom.telegramDisconnectCopy.textContent = `Talli will stop sending updates to ${displayName}. Your ledger will stay intact.`;
  }
  if (dom.telegramDisconnectConfirm) {
    dom.telegramDisconnectConfirm.focus();
  }
}

function renderAll() {
  renderMetrics();
  renderCustomerList();
  renderActivityFeed();
  renderClarification();
  renderCustomerDetail();
  renderComposerState();
  renderNotice();
  renderProposalReview();
  renderCollaborationActivity();
  renderAccountCard();
  renderTelegramDisconnectModal();
  if (dom.currencySelect) {
    dom.currencySelect.value = state.account.connected
      ? state.account.preferredCurrency || state.ledger?.currency || 'NGN'
      : state.ledger?.currency || 'NGN';
  }
  saveStoredJson(STORAGE_KEYS.conversation, state.conversation);
  saveStoredJson(STORAGE_KEYS.selectedCustomer, state.selectedCustomerId);
  saveStoredJson(STORAGE_KEYS.collaboration, state.proposalPanel.activity);
}

function setNotice(message) {
  state.notice = message;
  dom.workspaceNote.textContent = message;
}

function clearNotice() {
  state.notice = '';
  dom.workspaceNote.textContent = DEFAULT_WORKSPACE_NOTE;
}

function appendActivityMessage(entry) {
  state.proposalPanel = {
    ...state.proposalPanel,
    activity: appendProposalActivity(state.proposalPanel.activity ?? [], entry),
  };
  saveStoredJson(STORAGE_KEYS.collaboration, state.proposalPanel.activity);
  renderCollaborationActivity();
}

function applyProposalOutcome(outcome) {
  state.proposalPanel = withProposalOutcome(state.proposalPanel, outcome);
  saveStoredJson(STORAGE_KEYS.collaboration, state.proposalPanel.activity);
  renderProposalReview();
}

function setCurrentProposal(proposal) {
  state.proposalPanel = withCurrentProposal(state.proposalPanel, proposal);
  renderProposalReview();
}

async function loadCurrentProposal() {
  try {
    const current = await api.proposalCurrent();
    if (current.status === 'pending' && current.proposal) {
      setCurrentProposal(current.proposal);
      return;
    }

    state.proposalPanel = {
      ...state.proposalPanel,
      activeProposal: null,
      busyAction: null,
    };
    renderProposalReview();
  } catch (error) {
    console.error(error);
  }
}

async function refreshLedgerAndSelection() {
  await refreshLedgerData();
  await loadCurrentProposal();
  renderAll();
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
  const externalSignal = options.signal ?? null;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const { signal: _signal, ...requestOptions } = options;
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...(requestOptions.headers ?? {}),
    };
    const response = await fetch(path, {
      ...requestOptions,
      credentials: 'same-origin',
      headers: requestHeaders,
      signal: controller.signal,
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const error = new Error(`Request failed with status ${response.status}`);
      error.body = body;
      throw error;
    }

    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && !externalSignal?.aborted) {
      throw new Error(API_TIMEOUT_NOTICE);
    }
    throw error;
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    window.clearTimeout(timeoutId);
  }
}

const api = {
  async health() {
    return apiRequest('/api/health');
  },
  async me() {
    return apiRequest('/api/me');
  },
  async ledger() {
    return apiRequest('/api/ledger');
  },
  async proposalCurrent() {
    return apiRequest('/api/proposals/current');
  },
  async proposalPrepare(body, signal) {
    return apiRequest('/api/proposals/prepare', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  },
  async proposalConfirm(proposalId, signal) {
    return apiRequest('/api/proposals/confirm', {
      method: 'POST',
      body: JSON.stringify({ proposalId }),
      signal,
    });
  },
  async proposalCancel(proposalId, signal) {
    return apiRequest('/api/proposals/cancel', {
      method: 'POST',
      body: JSON.stringify({ proposalId }),
      signal,
    });
  },
  async customers() {
    return apiRequest('/api/customers');
  },
  async customer(customerId) {
    return apiRequest(`/api/customers/${encodeURIComponent(customerId)}`);
  },
  async createTelegramLink() {
    return apiRequest('/api/auth/telegram/link-token', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  async disconnectTelegram() {
    return apiRequest('/api/auth/telegram/disconnect', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  async linkStatus(token) {
    return apiRequest(`/api/auth/telegram/link-status?token=${encodeURIComponent(token)}`);
  },
  async setCurrency(currency) {
    return apiRequest('/api/preferences/currency', {
      method: 'POST',
      body: JSON.stringify({ currency }),
    });
  },
  async message(text) {
    const body = {
      text,
      referenceTime: new Date().toISOString(),
      timezone: TIMEZONE,
      language: detectLanguage(text),
      origin: 'web',
    };
    return apiRequest('/api/message', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};

async function loadDashboard() {
  state.loading = true;
  document.body.dataset.loading = 'true';
  renderAll();

  try {
    const me = await api.me();
    state.account = {
      connected: Boolean(me.connected),
      userId: me.userId ?? null,
      telegramUsername: me.telegramUsername ?? null,
      preferredCurrency: me.preferredCurrency ?? 'NGN',
      linkToken: null,
      linkTokenStatus: 'idle',
      deepLink: null,
    };

    const health = await api.health();
    state.health = health;

    const ledger = await api.ledger();
    state.ledger = ledger;
    await loadCustomerDetails(ledger.customers);

    if (
      !state.selectedCustomerId ||
      !ledger.customers.some((customer) => customer.id === state.selectedCustomerId)
    ) {
      state.selectedCustomerId = ledger.customers[0]?.id ?? null;
    }

    if (state.selectedCustomerId) {
      await ensureCustomerDetail(state.selectedCustomerId);
    }

    if (state.conversation.length > 0) {
      const last = state.conversation[state.conversation.length - 1];
      state.clarification = last.response.status === 'clarification_required' ? last : null;
      if (state.clarification) {
        state.transcriptPreview = '';
      }
    }

    await loadCurrentProposal();

    if (dom.currencySelect) {
      dom.currencySelect.value = state.account.preferredCurrency || ledger.currency || 'NGN';
    }
  } catch (error) {
    state.health = null;
    state.notice = "Talli couldn't load right now. Your ledger stays safe.";
    console.error(error);
  } finally {
    state.loading = false;
    document.body.dataset.loading = 'false';
    document.body.dataset.ready = 'true';
    renderAll();
  }
}

async function loadCustomerDetails(customers) {
  const entries = await Promise.all(
    customers.map(async (customer) => {
      try {
        const detail = await api.customer(customer.id);
        return [customer.id, detail];
      } catch {
        return [customer.id, { customer, obligations: [], events: [], recentTurns: [] }];
      }
    }),
  );
  state.customerDetails = new Map(entries);
}

async function ensureCustomerDetail(customerId) {
  const detail = state.customerDetails.get(customerId);
  if (detail?.customer) {
    return detail;
  }

  try {
    const fetched = await api.customer(customerId);
    state.customerDetails.set(customerId, fetched);
    return fetched;
  } catch {
    return null;
  }
}

function setSelectedCustomer(customerId) {
  state.selectedCustomerId = customerId;
  saveStoredJson(STORAGE_KEYS.selectedCustomer, customerId);
  renderCustomerList();
  renderCustomerDetail();
}

function setComposerText(value) {
  dom.composerInput.value = value;
  state.transcriptPreview = value.trim();
  renderComposerState();
}

function clearComposer() {
  dom.composerInput.value = '';
  state.transcriptPreview = '';
  finalTranscript = '';
  interimTranscript = '';
  renderComposerState();
  dom.composerInput.focus();
}

async function submitComposer() {
  const text = dom.composerInput.value.trim();
  if (!text || state.sending) {
    return;
  }

  state.sending = true;
  state.pendingSubmission = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    text,
  };
  state.transcriptPreview = text;
  clearRecognitionBuffer();
  setNotice('Updating your ledger...');
  renderAll();

  try {
    const response = await api.message(text);
    const conversationItem = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      text,
      response,
    };
    state.conversation = [...state.conversation, conversationItem].slice(-24);

    if (response.status === 'clarification_required') {
      state.clarification = conversationItem;
    } else {
      state.clarification = null;
    }

    if (response.ledgerChange?.customerId) {
      state.selectedCustomerId = response.ledgerChange.customerId;
      saveStoredJson(STORAGE_KEYS.selectedCustomer, state.selectedCustomerId);
    }

    dom.composerInput.value = '';
    state.transcriptPreview = '';
    state.pendingSubmission = null;
    clearRecognitionBuffer();
    setNotice(
      response.status === 'applied'
        ? 'Ledger updated.'
        : response.status === 'clarification_required'
          ? 'Clarification stays visible until you resolve it.'
          : response.status === 'no_action'
            ? 'No ledger change was made.'
            : SAFE_FAILURE_NOTICE,
    );
    renderAll();
    try {
      await refreshLedgerData();
    } catch (refreshError) {
      console.error(refreshError);
      setNotice('The update was recorded, but the ledger view could not refresh.');
      renderAll();
    }
  } catch (error) {
    const failureNotice =
      error instanceof Error && error.message === API_TIMEOUT_NOTICE
        ? API_TIMEOUT_NOTICE
        : SAFE_FAILURE_NOTICE;
    state.conversation = [
      ...state.conversation,
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        text,
        response: {
          status: 'error',
          message: failureNotice,
          action: { type: 'NO_ACTION' },
          ledgerChange: null,
          clarification: null,
          turnId: null,
          sessionId: DEMO_SESSION_ID,
          errorCode: 'SAFE_FAILURE',
          modelAvailable: Boolean(state.health?.modelAvailable),
        },
      },
    ].slice(-24);
    state.pendingSubmission = null;
    setNotice(failureNotice);
    console.error(error);
  } finally {
    state.sending = false;
    state.pendingSubmission = null;
    renderAll();
    dom.composerInput.focus();
  }
}

async function refreshLedgerData() {
  const ledger = await api.ledger();
  state.ledger = ledger;
  if (!state.account.connected && dom.currencySelect) {
    dom.currencySelect.value = ledger.currency ?? 'NGN';
  }
  await loadCustomerDetails(ledger.customers);
  if (state.selectedCustomerId) {
    await ensureCustomerDetail(state.selectedCustomerId);
  }
}

async function confirmPendingProposal() {
  const started = beginProposalAction(state.proposalPanel, 'confirm');
  if (!started.started || !state.proposalPanel.activeProposal) {
    return;
  }

  state.proposalPanel = started.state;
  renderProposalReview();

  const proposalId = state.proposalPanel.activeProposal.proposalId;
  try {
    const response = await api.proposalConfirm(proposalId);
    state.proposalPanel = finishProposalAction(state.proposalPanel, response);
    if (response.status === 'confirmed') {
      appendActivityMessage(
        createProposalActivityEntry(
          formatProposalActivityMessage('confirm', response.proposal?.operation),
        ),
      );
    }
    setNotice(formatConfirmStateMessage(response));
    await refreshLedgerAndSelection();
    renderAll();
  } catch (error) {
    const failureNotice = error instanceof Error ? error.message : SAFE_FAILURE_NOTICE;
    state.proposalPanel = {
      ...state.proposalPanel,
      busyAction: null,
      liveMessage: failureNotice,
    };
    setNotice(failureNotice);
    renderProposalReview();
    console.error(error);
  }
}

async function cancelPendingProposal() {
  const started = beginProposalAction(state.proposalPanel, 'cancel');
  if (!started.started || !state.proposalPanel.activeProposal) {
    return;
  }

  state.proposalPanel = started.state;
  renderProposalReview();

  const proposalId = state.proposalPanel.activeProposal.proposalId;
  try {
    const response = await api.proposalCancel(proposalId);
    state.proposalPanel = finishProposalAction(state.proposalPanel, response);
    if (response.status === 'cancelled') {
      appendActivityMessage(
        createProposalActivityEntry(
          formatProposalActivityMessage('cancel', response.proposal?.operation),
        ),
      );
    }
    setNotice(formatConfirmStateMessage(response));
    await refreshLedgerAndSelection();
    renderAll();
  } catch (error) {
    const failureNotice = error instanceof Error ? error.message : SAFE_FAILURE_NOTICE;
    state.proposalPanel = {
      ...state.proposalPanel,
      busyAction: null,
      liveMessage: failureNotice,
    };
    setNotice(failureNotice);
    renderProposalReview();
    console.error(error);
  }
}

async function connectTelegram() {
  if (state.account.connected || state.account.linkTokenStatus === 'pending') {
    return;
  }

  const telegramWindow = window.open('', '_blank');
  state.account.linkTokenStatus = 'pending';
  state.account.deepLink = null;
  renderAll();

  try {
    const response = await api.createTelegramLink();
    const popupStatus = handleTelegramLinkResponse(telegramWindow, response.deepLink);
    if (popupStatus.status === 'invalid') {
      state.account.linkToken = null;
      state.account.linkTokenStatus = 'idle';
      state.account.deepLink = null;
      setNotice('Talli could not create a Telegram link right now.');
      renderAll();
      return;
    }

    state.account.linkToken = response.linkToken;
    state.account.deepLink = response.deepLink;
    if (popupStatus.status !== 'opened') {
      setNotice('Telegram did not open. Use the link below to continue.');
    }
    renderAll();

    const deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = await api.linkStatus(response.linkToken);
      if (status.connected) {
        state.account.connected = true;
        state.account.userId = status.userId ?? state.account.userId;
        state.account.linkTokenStatus = 'connected';
        state.account.preferredCurrency =
          status.preferredCurrency || state.account.preferredCurrency;
        state.account.deepLink = null;
        setNotice('Telegram connected.');
        await loadDashboard();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }

    handleTelegramLinkFailure(telegramWindow);
    state.account.linkTokenStatus = 'idle';
    setNotice('Telegram link expired. Generate a fresh link and try again.');
  } catch (error) {
    console.error(error);
    handleTelegramLinkFailure(telegramWindow);
    state.account.linkTokenStatus = 'idle';
    state.account.linkToken = null;
    state.account.deepLink = null;
    setNotice('Talli could not create a Telegram link right now.');
  } finally {
    renderAll();
  }
}

function openTelegramDisconnectModal() {
  if (!state.account.connected) {
    return;
  }

  state.telegramDisconnectOpen = true;
  renderAll();
}

function closeTelegramDisconnectModal() {
  if (!state.telegramDisconnectOpen) {
    return;
  }

  state.telegramDisconnectOpen = false;
  renderAll();
}

async function disconnectTelegram() {
  if (!state.account.connected) {
    closeTelegramDisconnectModal();
    return;
  }

  try {
    await api.disconnectTelegram();
    state.telegramDisconnectOpen = false;
    setNotice('Telegram disconnected.');
    await loadDashboard();
  } catch (error) {
    console.error(error);
    setNotice('Talli could not disconnect Telegram right now.');
  } finally {
    renderAll();
  }
}

async function updateCurrencyPreference() {
  const select = dom.currencySelect;
  if (!select) {
    return;
  }

  const currency = select.value.trim().toUpperCase();
  if (!currency) {
    return;
  }

  state.account.preferredCurrency = currency;
  if (state.account.connected) {
    await api.setCurrency(currency);
    await refreshLedgerData();
    setNotice(`Ledger currency set to ${currency}.`);
  } else {
    await api.setCurrency(currency);
    await refreshLedgerData();
    setNotice(`Ledger currency set to ${currency}.`);
  }
  renderAll();
}

function clearRecognitionBuffer() {
  finalTranscript = '';
  interimTranscript = '';
  state.listening = false;
  state.voiceSupport.status = 'ready';
}

function initSpeechRecognition() {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    state.voiceSupport.supported = false;
    state.voiceSupport.note = "Voice input isn't available here. Type your update instead.";
    renderComposerState();
    return;
  }

  state.voiceSupport.supported = true;
  state.voiceSupport.note = 'Tap the mic and tell Talli what happened.';
  recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-GB';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.addEventListener('start', () => {
    state.listening = true;
    state.voiceSupport.status = 'listening';
    state.transcriptPreview = '';
    interimTranscript = '';
    finalTranscript = '';
    renderComposerState();
  });

  recognition.addEventListener('result', (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript?.trim() ?? '';
      if (result.isFinal) {
        finalTranscript = `${finalTranscript} ${transcript}`.trim();
      } else {
        interim = transcript;
      }
    }

    interimTranscript = interim;
    const combined = [finalTranscript, interimTranscript].filter(Boolean).join(' ').trim();
    dom.composerInput.value = combined;
    state.transcriptPreview = combined;
    renderComposerState();
  });

  recognition.addEventListener('error', (event) => {
    state.listening = false;
    state.voiceSupport.status = 'error';
    console.warn('SpeechRecognition error', {
      error: event.error,
      message: event.message ?? null,
    });
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      state.voiceSupport.note = 'Microphone access was blocked. Type your update instead.';
    } else if (event.error === 'network') {
      state.voiceSupport.note = 'Voice input could not connect. Please type your update instead.';
    } else if (event.error === 'audio-capture') {
      state.voiceSupport.note = "We couldn't access your microphone. Type your update instead.";
    } else if (event.error === 'no-speech') {
      state.voiceSupport.note = 'No speech was captured. Try again or type your update instead.';
    } else if (event.error === 'aborted') {
      state.voiceSupport.note = 'Voice input stopped. Type your update instead.';
    } else {
      state.voiceSupport.note = 'Voice input failed. Type your update instead.';
    }
    renderComposerState();
  });

  recognition.addEventListener('end', () => {
    state.listening = false;
    const hadError = state.voiceSupport.status === 'error';
    if (finalTranscript || interimTranscript) {
      const combined = [finalTranscript, interimTranscript].filter(Boolean).join(' ').trim();
      dom.composerInput.value = combined;
      state.transcriptPreview = combined;
      state.voiceSupport.note = 'Transcript ready. Review it before you send it.';
    } else if (!hadError) {
      state.voiceSupport.note =
        'No speech was captured. Tap the mic and try again, or type your update.';
      state.transcriptPreview = '';
    }
    state.voiceSupport.status = hadError ? 'error' : 'ready';
    renderComposerState();
  });
}

function toggleRecognition() {
  if (!recognition || !state.voiceSupport.supported || state.sending) {
    return;
  }

  if (state.listening) {
    recognition.stop();
    return;
  }

  try {
    recognition.start();
  } catch {
    state.voiceSupport.status = 'error';
    state.voiceSupport.note = "Voice input couldn't start. Type your update instead.";
    renderComposerState();
  }
}

function bindEvents() {
  dom.navToggle.addEventListener('click', () => {
    const isOpen = dom.primaryNav.dataset.open === 'true';
    dom.primaryNav.dataset.open = String(!isOpen);
    dom.navToggle.setAttribute('aria-expanded', String(!isOpen));
  });

  dom.primaryNav.addEventListener('click', (event) => {
    if (
      event.target instanceof HTMLAnchorElement &&
      event.target.getAttribute('href')?.startsWith('#')
    ) {
      dom.primaryNav.dataset.open = 'false';
      dom.navToggle.setAttribute('aria-expanded', 'false');
      if (event.target.getAttribute('href') === '#workspace') {
        window.setTimeout(() => dom.composerInput.focus(), 200);
      }
    }
  });

  for (const button of dom.tryButtons) {
    button.addEventListener('click', () => {
      window.setTimeout(() => dom.composerInput.focus(), 160);
    });
  }

  dom.micToggle.addEventListener('click', toggleRecognition);
  dom.clearComposer.addEventListener('click', clearComposer);
  dom.connectTelegramButton?.addEventListener('click', () => {
    if (state.account.connected) {
      openTelegramDisconnectModal();
      return;
    }
    void connectTelegram();
  });
  for (const button of dom.connectTelegramCtas ?? []) {
    button.addEventListener('click', () => {
      if (state.account.connected) {
        openTelegramDisconnectModal();
        return;
      }
      void connectTelegram();
    });
  }
  dom.currencySelect?.addEventListener('change', () => {
    void updateCurrencyPreference();
  });
  dom.composerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitComposer();
  });
  dom.proposalConfirm?.addEventListener('click', () => {
    void confirmPendingProposal();
  });
  dom.proposalCancel?.addEventListener('click', () => {
    void cancelPendingProposal();
  });

  dom.customerList.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('[data-customer-id]') : null;
    if (!button) {
      return;
    }
    const customerId = button.getAttribute('data-customer-id');
    if (customerId) {
      setSelectedCustomer(customerId);
    }
  });

  dom.clarificationCandidates.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('[data-candidate-suggestion]') : null;
    if (!button) {
      return;
    }
    const suggestion = button.getAttribute('data-candidate-suggestion') ?? '';
    if (suggestion) {
      setComposerText(suggestion);
      dom.composerInput.focus();
    }
  });

  dom.telegramDisconnectCancel?.addEventListener('click', () => {
    closeTelegramDisconnectModal();
  });
  dom.telegramDisconnectConfirm?.addEventListener('click', () => {
    void disconnectTelegram();
  });
  dom.telegramDisconnectModal?.addEventListener('click', (event) => {
    if (event.target === dom.telegramDisconnectModal) {
      closeTelegramDisconnectModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.telegramDisconnectOpen) {
      closeTelegramDisconnectModal();
      return;
    }
    if (event.key === 'Escape' && dom.primaryNav.dataset.open === 'true') {
      dom.primaryNav.dataset.open = 'false';
      dom.navToggle.setAttribute('aria-expanded', 'false');
    }
  });
}

function cacheDom() {
  dom.workspaceNote = document.querySelector('[data-role="workspace-note"]');
  dom.ledgerCount = document.querySelector('[data-role="ledger-count"]');
  dom.customerCount = document.querySelector('[data-role="customer-count"]');
  dom.turnCount = document.querySelector('[data-role="turn-count"]');
  dom.activityFeed = document.querySelector('[data-role="activity-feed"]');
  dom.activityEmpty = document.querySelector('[data-role="activity-empty"]');
  dom.metricsGrid = document.querySelector('[data-role="metrics-grid"]');
  dom.customerList = document.querySelector('[data-role="customer-list"]');
  dom.customerDetail = document.querySelector('[data-role="customer-detail"]');
  dom.detailTitle = document.querySelector('[data-role="detail-title"]');
  dom.detailStatus = document.querySelector('[data-role="detail-status"]');
  dom.accountStatus = document.querySelector('[data-role="account-status"]');
  dom.connectTelegramButton = document.querySelector('[data-role="connect-telegram-button"]');
  dom.connectTelegramCtas = Array.from(
    document.querySelectorAll('[data-role="connect-telegram-cta"]'),
  );
  dom.telegramLink = document.querySelector('[data-role="telegram-link"]');
  dom.currencySelect = document.querySelector('[data-role="currency-select"]');
  dom.clarificationPanel = document.querySelector('[data-role="clarification-panel"]');
  dom.clarificationTitle = document.querySelector('[data-role="clarification-title"]');
  dom.clarificationQuestion = document.querySelector('[data-role="clarification-question"]');
  dom.clarificationCandidates = document.querySelector('[data-role="clarification-candidates"]');
  dom.proposalPanel = document.querySelector('[data-role="proposal-panel"]');
  dom.proposalHeadline = document.querySelector('[data-role="proposal-headline"]');
  dom.proposalStatus = document.querySelector('[data-role="proposal-status"]');
  dom.proposalSummary = document.querySelector('[data-role="proposal-summary"]');
  dom.proposalMessage = document.querySelector('[data-role="proposal-message"]');
  dom.proposalOperation = document.querySelector('[data-role="proposal-operation"]');
  dom.proposalExpires = document.querySelector('[data-role="proposal-expires"]');
  dom.proposalCandidates = document.querySelector('[data-role="proposal-candidates"]');
  dom.proposalConfirm = document.querySelector('[data-role="proposal-confirm"]');
  dom.proposalCancel = document.querySelector('[data-role="proposal-cancel"]');
  dom.proposalLive = document.querySelector('[data-role="proposal-live"]');
  dom.collaborationFeed = document.querySelector('[data-role="collaboration-feed"]');
  dom.collaborationEmpty = document.querySelector('[data-role="collaboration-empty"]');
  dom.collaborationCount = document.querySelector('[data-role="collaboration-count"]');
  dom.composerForm = document.querySelector('[data-role="composer-form"]');
  dom.composerInput = document.querySelector('[data-role="composer-input"]');
  dom.micToggle = document.querySelector('[data-role="mic-toggle"]');
  dom.micLabel = document.querySelector('[data-role="mic-label"]');
  dom.voicePrompt = document.querySelector('[data-role="voice-prompt"]');
  dom.clearComposer = document.querySelector('[data-role="clear-composer"]');
  dom.sendMessage = document.querySelector('[data-role="send-message"]');
  dom.sendLabel = document.querySelector('[data-role="send-label"]');
  dom.composerState = document.querySelector('[data-role="composer-state"]');
  dom.voiceSupportNote = document.querySelector('[data-role="voice-support-note"]');
  dom.transcriptPreview = document.querySelector('[data-role="transcript-preview"]');
  dom.navToggle = document.querySelector('[data-role="nav-toggle"]');
  dom.primaryNav = document.querySelector('[data-role="primary-nav"]');
  dom.tryButtons = document.querySelectorAll('a[href="#workspace"]');
  dom.telegramDisconnectModal = document.querySelector('[data-role="telegram-disconnect-modal"]');
  dom.telegramDisconnectCancel = document.querySelector('[data-role="telegram-disconnect-cancel"]');
  dom.telegramDisconnectConfirm = document.querySelector(
    '[data-role="telegram-disconnect-confirm"]',
  );
  dom.telegramDisconnectCopy = document.querySelector('[data-role="telegram-disconnect-copy"]');
}

async function init() {
  cacheDom();
  initSpeechRecognition();
  bindEvents();
  void registerTalliWebMcpTools({
    document,
    requestJson: apiRequest,
    onActivity: appendActivityMessage,
    onProposalOutcome: applyProposalOutcome,
  });
  window.addEventListener(
    'pagehide',
    () => {
      abortTalliWebMcpTools();
    },
    { once: true },
  );
  await loadDashboard();
}

window.addEventListener('DOMContentLoaded', () => {
  void init();
});
