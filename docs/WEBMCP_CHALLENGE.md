# Talli WebMCP Challenge

## Challenge Thesis

Talli is a voice-first conversational credit ledger. The WebMCP challenge adds a browser-native agent interface so a human and a browser agent can work on the same live financial state.

WebMCP materially improves Talli because the browser agent can:

- read the same ledger the human sees
- search customers and balances
- prepare a proposed mutation safely
- stop at clarification instead of guessing
- let the human confirm the final change in the visible UI

## Human-Agent Boundary

- Agent: read tools and proposal preparation
- Human: final confirmation in the visible Talli interface
- Backend: validates, resolves, and stores proposals

There is no agent-callable confirmation tool.

## Tool Inventory

Exactly seven browser tools are registered:

1. `get_ledger_summary`
2. `search_customers`
3. `get_customer_balance`
4. `get_customer_history`
5. `list_overdue_debts`
6. `prepare_ledger_mutation`
7. `cancel_ledger_mutation`

Read tools are marked `readOnlyHint: true`. Mutation tools are marked `readOnlyHint: false`.

## Mutation State Machine

1. Agent calls `prepare_ledger_mutation`.
2. Talli resolves entities and validates the request.
3. If safe, Talli stores an opaque proposal id in the session state.
4. The UI shows a visible review card.
5. The human clicks Confirm in Talli.
6. The ledger mutates once, or the call returns `already_confirmed`.

Safety details:

- proposal ids are opaque and short-lived
- expiry is ten minutes
- the ledger fingerprint is captured at prepare time
- stale proposals are rejected if the ledger changes
- confirm and cancel are idempotent
- only one pending proposal is kept per session

## Ambiguity Example

Verified production behavior:

- three customers matched "Ada"
- the payment request returned `clarification_required`
- `reasonCode` was `AMBIGUOUS_CUSTOMER`
- three bounded candidates were returned
- the ledger total stayed at 150,000

Talli did not guess and did not mutate the ledger.

## Security Design

- same-origin browser tools only
- no backend MCP server
- strict JSON schemas
- `additionalProperties: false`
- `Origin-Agent-Cluster: ?1`
- `Permissions-Policy: tools=(self)`
- signed anonymous browser sessions
- no shared default ledger for public visitors
- proposal confirmation is session-owned and idempotent

## Production Verification Checklist

- production health returns 200
- browser loads the WebMCP tools
- read tools work
- prepare creates a visible proposal
- human confirmation mutates the ledger exactly once
- clarification returns bounded candidates and no mutation
- anonymous browser sessions remain isolated
- Telegram linking works through the configured bot

## Pre-existing vs New Work

Pre-existing Talli:

- voice/text conversational ledger
- event-sourced financial state
- customer/entity resolution
- partial/full payments
- corrections
- ambiguity abstention
- Telegram/web shared ledger
- Supabase persistence

WebMCP extension:

- imperative `document.modelContext.registerTool` integration
- seven structured browser tools
- visible human review card
- idempotent confirmation path
- stale and expiry protection
- collaboration activity in the UI
- isolated signed browser sessions
- WebMCP security headers

## Limitations

- the proposal lock is process-local, not distributed
- the deployment is intended to run as a single web instance
- ordinary browsers without `document.modelContext` still work, but they do not expose tools
- Telegram is optional for this deployment and should remain disabled unless explicitly configured

