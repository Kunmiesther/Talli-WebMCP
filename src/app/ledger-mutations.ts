import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LedgerAction } from '../domain/actions.js';
import type { LedgerDocument, LedgerSnapshot } from '../domain/ledger.js';
import { formatMinorUnits, nairaToMinorUnits } from '../domain/money.js';

export const proposalIdSchema = z.string().uuid();

export const proposalMutationRequestSchema = z
  .object({
    proposalId: proposalIdSchema,
  })
  .strict();

export const humanMoneySchema = z
  .object({
    value: z.number().finite().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const strictCustomerRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('new'),
      name: z.string().min(1),
      aliases: z.array(z.string().min(1)).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('id'),
      customerId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('name'),
      name: z.string().min(1),
      allowCreate: z.boolean().default(false),
    })
    .strict(),
]);

export const strictObligationRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('id'),
      obligationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('latestOpenForCustomer'),
      customer: strictCustomerRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('latestForCustomer'),
      customer: strictCustomerRefSchema,
    })
    .strict(),
]);

export const prepareCreateCreditSchema = z
  .object({
    operation: z.literal('CREATE_OBLIGATION'),
    customer: strictCustomerRefSchema,
    amount: humanMoneySchema,
    dueAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export const prepareRecordPaymentSchema = z
  .object({
    operation: z.literal('RECORD_PAYMENT'),
    customer: strictCustomerRefSchema.optional(),
    obligation: strictObligationRefSchema.optional(),
    amount: humanMoneySchema.optional(),
    settleRemaining: z.boolean().default(false),
  })
  .strict();

export const prepareSettleObligationSchema = z
  .object({
    operation: z.literal('SETTLE_OBLIGATION'),
    obligation: strictObligationRefSchema,
    amount: humanMoneySchema.optional(),
  })
  .strict();

export const prepareLedgerMutationRequestSchema = z.discriminatedUnion('operation', [
  prepareCreateCreditSchema,
  prepareRecordPaymentSchema,
  prepareSettleObligationSchema,
]);

export const proposalCandidateSchema = z
  .object({
    kind: z.enum(['customer', 'obligation']),
    id: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

export type PrepareLedgerMutationRequest = z.infer<typeof prepareLedgerMutationRequestSchema>;

export type ProposalCandidate = z.infer<typeof proposalCandidateSchema>;

export type ProposalAction = Extract<
  LedgerAction,
  { type: 'CREATE_OBLIGATION' | 'RECORD_PAYMENT' | 'SETTLE_OBLIGATION' }
>;

export interface LedgerMutationSummary {
  proposalId: string;
  operation: ProposalAction['type'];
  summary: string;
  createdAt: string;
  expiresAt: string;
  ledgerRevision: number;
  ledgerFingerprint: string;
}

export function humanMoneyToMinorUnits(input: z.infer<typeof humanMoneySchema>): number {
  const currency = input.currency.toUpperCase();
  if (currency === 'NGN') {
    return nairaToMinorUnits(input.value);
  }

  return Math.round(input.value * 100);
}

export function formatProposalMoney(minorUnits: number, currency: string): string {
  return formatMinorUnits(minorUnits, currency);
}

export function computeLedgerFingerprint(snapshot: LedgerSnapshot): string {
  const payload = JSON.stringify({
    id: snapshot.id,
    currency: snapshot.currency,
    customers: snapshot.customers.map((customer) => ({
      id: customer.id,
      displayName: customer.displayName,
      aliases: customer.aliases,
      sourceEventIds: customer.sourceEventIds,
    })),
    obligations: snapshot.obligations.map((obligation) => ({
      id: obligation.id,
      customerId: obligation.customerId,
      customerName: obligation.customerName,
      originalAmountMinor: obligation.originalAmountMinor,
      totalPaidMinor: obligation.totalPaidMinor,
      outstandingMinor: obligation.outstandingMinor,
      status: obligation.status,
      dueAt: obligation.dueAt ?? null,
      sourceEventIds: obligation.sourceEventIds,
      paymentEventIds: obligation.paymentEventIds,
      correctionEventIds: obligation.correctionEventIds,
    })),
    totals: snapshot.totals,
  });

  return createHash('sha256').update(payload).digest('hex');
}

export function summarizeMutationAction(action: ProposalAction, snapshot: LedgerSnapshot): string {
  switch (action.type) {
    case 'CREATE_OBLIGATION': {
      const createAction = action;
      const amount = formatProposalMoney(action.amountMinor, snapshot.currency);
      let customerLabel = 'that customer';
      const customerRef = createAction.customer;
      switch (customerRef.kind) {
        case 'new':
        case 'name':
          customerLabel = customerRef.name;
          break;
        case 'id':
          customerLabel =
            snapshot.customers.find((customer) => customer.id === customerRef.customerId)
              ?.displayName ?? customerRef.customerId;
          break;
        default:
          customerLabel = 'that customer';
      }
      const dueAt = createAction.dueAt ? ' with a due date' : '';
      return `Create credit for ${customerLabel} for ${amount}${dueAt}.`;
    }
    case 'RECORD_PAYMENT': {
      const recordAction = action;
      const amount = recordAction.amountMinor ?? null;
      let obligation = null as (typeof snapshot.obligations)[number] | null;
      const obligationRef = recordAction.obligation;
      if (obligationRef && obligationRef.kind === 'id') {
        obligation =
          snapshot.obligations.find((entry) => entry.id === obligationRef.obligationId) ?? null;
      }

      let customerLabel = 'that customer';
      if (obligation?.customerName) {
        customerLabel = obligation.customerName;
      } else {
        const customerRef = recordAction.customer;
        if (customerRef) {
          switch (customerRef.kind) {
            case 'name':
            case 'new':
              customerLabel = customerRef.name;
              break;
            case 'id':
              customerLabel = customerRef.customerId;
              customerLabel =
                snapshot.customers.find((customer) => customer.id === customerRef.customerId)
                  ?.displayName ?? customerRef.customerId;
              break;
            case 'ambiguous':
              customerLabel =
                customerRef.name ?? customerRef.candidateCustomerIds.join(', ') ?? 'that customer';
              break;
            default:
              customerLabel = 'that customer';
          }
        }
      }
      const amountLabel =
        amount === null ? 'the remaining balance' : formatProposalMoney(amount, snapshot.currency);
      return recordAction.settleRemaining
        ? `Record a payment for ${customerLabel} and settle the remaining balance.`
        : `Record a payment of ${amountLabel} for ${customerLabel}.`;
    }
    case 'SETTLE_OBLIGATION': {
      const settleAction = action;
      let obligation = null as (typeof snapshot.obligations)[number] | null;
      const obligationRef = settleAction.obligation;
      if (obligationRef.kind === 'id') {
        obligation =
          snapshot.obligations.find((entry) => entry.id === obligationRef.obligationId) ?? null;
      }
      const customerLabel = obligation?.customerName ?? 'the customer';
      return `Settle ${customerLabel}'s obligation.`;
    }
    default: {
      const never: never = action;
      return never;
    }
  }
}

export function cloneLedgerDocument(document: LedgerDocument): LedgerDocument {
  return {
    ...document,
    events: [...document.events],
  };
}
