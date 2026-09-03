# Talli
Talli is an agent-native conversational credit ledger.

Live app: https://talli-webmcp.onrender.com/

Telegram bot: https://t.me/TalliMCP_bot

This repository is the WebMCP Challenge extension of the original Talli project: https://github.com/Kunmiesther/Talli

Send a voice note. Talli keeps the ledger.

## 1. What Talli Is

Talli helps a merchant keep a persistent credit ledger by speaking or typing ordinary business language. It tracks customers, open obligations, partial payments, settlements, corrections, aliases, and history so the person does not have to reconstruct the balance manually.

The product already existed before WebMCP. This repository adds a browser-native WebMCP layer and a visible human-review flow on top of the existing Talli system.

## 2. The Real Problem

Small businesses and informal traders usually do not think in database records. They think in sentences:

- "Ada owes me 65,000 naira."
- "She paid 10,000."
- "Close the debt."

The hard part is not capturing the words. The hard part is keeping the financial state correct when customers repeat, aliases overlap, payments are partial, obligations are ambiguous, and the same ledger must work across voice, text, web, and Telegram.

## 3. Why Talli Is a Strong WebMCP Use Case

Talli is a good fit for WebMCP because a browser agent can help with the same live state the human is already seeing:

- read the current ledger
- search customers and histories
- prepare a proposed mutation safely
- let the human confirm the exact change in the visible UI

That is a real collaboration boundary, not a thin CRUD wrapper.

## 4. Human + Agent Collaboration

The browser agent can read and prepare. The human confirms.

The visible workflow is:

1. The agent prepares a proposal.
2. Talli validates and resolves the request.
3. Talli shows a visible review card.
4. The human clicks Confirm in Talli.
5. The ledger changes exactly once.

If the request is ambiguous, Talli asks for clarification instead of guessing.

## 5. Verified Demo Journey

The production deployment at https://talli-webmcp.onrender.com/ was verified to do all of the following:

- expose exactly seven WebMCP tools in the browser
- let ChatGPT discover and use those tools
- read the ledger summary successfully
- prepare a mutation without changing the ledger
- apply a human-confirmed credit exactly once
- return clarification for an ambiguous "Ada paid 10,000" request
- keep the ledger total unchanged during ambiguity
- preserve Telegram linking and shared-ledger behavior
- isolate anonymous browser sessions

## 6. WebMCP Tools

Exactly seven tools are registered in the browser when `document.modelContext` is available:

| Tool | Purpose | Read-only |
| --- | --- | --- |
| `get_ledger_summary` | Summarize the current ledger state | Yes |
| `search_customers` | Search customers by name, alias, or id | Yes |
| `get_customer_balance` | Resolve one customer and show their balance | Yes |
| `get_customer_history` | Show compact customer history | Yes |
| `list_overdue_debts` | Show overdue open debts | Yes |
| `prepare_ledger_mutation` | Prepare a proposed credit, payment, or settlement | No |
| `cancel_ledger_mutation` | Cancel the current pending proposal | No |

There is no agent-callable confirmation tool.

## 7. Safe Financial Delegation

Talli does not expose a direct write tool to the browser agent.

The safe mutation flow is:

1. Agent prepares a request.
2. Talli resolves entities and validates the exact action.
3. Talli creates an opaque proposal id and stores it in session state.
4. The visible Talli UI shows the proposal for review.
5. The human confirms in Talli.
6. The ledger changes only if the proposal is still valid.

Safety details:

- proposal ids are opaque and short-lived
- proposals expire after ten minutes
- the stored ledger fingerprint prevents stale confirmation
- confirmation is idempotent
- cancellation is idempotent
- the same proposal cannot be applied twice
- backend serialization is process-local and session-scoped, not distributed locking

## 8. Ambiguity and Abstention

Talli is designed to abstain when the request is not safe to execute.

Example from the verified deployment:

- there were three customers matching "Ada"
- a payment request for "Ada" returned `clarification_required`
- the response used `AMBIGUOUS_CUSTOMER`
- three bounded candidates were returned
- the ledger total stayed at 150,000

This is the correct behavior for a financial ledger. Talli does not silently guess.

## 9. How WebMCP Is Implemented

WebMCP is browser-native. It is not a backend MCP server.

Implementation details:

- `public/app.js` feature-detects `document.modelContext`
- `public/webmcp-tools.js` registers the seven tools imperatively
- every tool uses same-origin JSON requests
- tool schemas are strict JSON Schemas with `additionalProperties: false`
- read tools set `annotations.readOnlyHint: true`
- mutation tools set `annotations.readOnlyHint: false`
- tools that surface customer names or ledger content set `annotations.untrustedContentHint: true`
- the browser still works normally when `document.modelContext` is absent

## 10. Architecture

- Frontend: plain JavaScript in `public/`
- Backend: TypeScript on Node.js in `src/`
- Persistence: Supabase in production, file-backed storage for local development
- Hosting: Render
- State model: event-sourced ledger with session-scoped proposal state
- Telegram: existing linked-web-session flow, not a separate ledger

Core directories:

- `src/app/`
- `src/domain/`
- `src/integrations/`
- `public/`
- `supabase/`
- `tests/`
- `docs/`

## 11. Pre-existing Talli vs WebMCP Challenge Extension

| Pre-existing Talli | WebMCP Challenge extension |
| --- | --- |
| Voice-first conversational credit ledger | Imperative `document.modelContext.registerTool` integration |
| Event-sourced financial state | Seven structured browser tools |
| Customer/entity resolution | Strict JSON Schemas and safe ambiguity handling |
| Partial/full payments and corrections | Proposal/confirmation state machine |
| Ambiguity abstention | Visible human review before ledger mutation |
| Telegram/web shared ledger | Idempotent confirmation and stale protection |
| Supabase persistence | Isolated signed browser sessions and WebMCP headers |

WebMCP work in this repository lives on the dedicated `webmcp-challenge` branch.

## 12. Running Locally

```bash
npm ci
npm run build
npm run typecheck
npm test
```

For local development:

```bash
npm run dev:api
```

Optional Telegram worker:

```bash
npm run dev:telegram
```

Copy `.env.example` to `.env` and set only the services you actually need.

## 13. Testing WebMCP

Practical ways to verify the browser integration:

- ChatGPT in-app browser
- Chrome flag `chrome://flags/#enable-webmcp-testing` when supported
- Model Context Tool Inspector when compatible
- an ordinary browser, which should still load Talli normally even without `document.modelContext`

Useful commands:

```bash
npm test
npm run build
npm run typecheck
npx.cmd biome check public/app.js public/proposal-workbench.js public/webmcp-tools.js src/app/ledger-mutations.ts src/app/talli-service.ts src/domain/ledger.ts tests/ledger-mutations.test.ts tests/proposal-workbench.test.ts tests/public-app.test.ts tests/webmcp-tools.test.ts
```

## 14. Deployment

The WebMCP challenge deployment runs on Render as a separate Node web service.

- deployment guide: [docs/WEBMCP_DEPLOYMENT.md](docs/WEBMCP_DEPLOYMENT.md)
- production URL: https://talli-webmcp.onrender.com/

The deployment uses the same-origin browser UI and API, and the production responses include:

- `Origin-Agent-Cluster: ?1`
- `Permissions-Policy: tools=(self)`

## 15. Environment Variables

Required for the WebMCP deployment:

- `SESSION_SECRET`
- `TALLI_STORAGE_DRIVER`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional LLM variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`
- `TRANSCRIPTION_API_KEY`
- `TRANSCRIPTION_MODEL`
- `TRANSCRIPTION_BASE_URL`

Optional local/runtime variables:

- `TALLI_TIMEZONE`
- `TALLI_HOST`
- `TALLI_PORT`

Telegram variables should be omitted for the WebMCP deployment unless you intentionally want Telegram enabled:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `TALLI_PUBLIC_URL`

Never commit secrets. Enter them only in Render or your local `.env` file.

## 16. Tests and Verified Results

Automated tests cover:

- ledger mutation proposals
- session isolation
- Telegram linking and webhook behavior
- browser WebMCP registration and schema validation
- proposal workbench rendering helpers
- public app source checks

Verified live results from the production deployment:

- seven WebMCP tools discovered in the browser
- `get_ledger_summary` succeeded
- `prepare_ledger_mutation` produced a proposal without mutating the ledger
- human confirmation applied a `65,000` credit exactly once
- ambiguous Ada payment returned clarification and left the ledger unchanged
- Telegram worked through `@TalliMCP_bot`
- anonymous browser sessions were isolated
- the required WebMCP headers were present

## 17. Security and Privacy

Safety rules in the current implementation:

- browser sessions are signed
- public visitors do not share a default ledger
- mutation proposals are session-owned
- confirmation is idempotent and proposal-scoped
- clarification responses do not leak the full ledger
- WebMCP remains same-origin
- there is no permissive cross-origin exposure
- logs avoid secrets and tokens

## 18. Current Limitations

- proposal serialization is process-local, not distributed locking
- Render is run as a single web instance for safe mutation ordering
- ordinary browsers without `document.modelContext` do not expose WebMCP tools
- Telegram is optional and should remain disabled in the challenge deployment unless intentionally configured
- file storage is still ephemeral on Render if used instead of Supabase

## 19. Repository Structure

```text
public/                  Browser UI and WebMCP registration
src/app/                 HTTP API, storage, and Talli service
src/domain/              Ledger, actions, and money types
src/integrations/        Telegram and transcription integrations
supabase/                Database schema and migrations
tests/                   Automated tests
docs/                    Challenge, deployment, submission, and demo docs
```

## 20. License

MIT. See [LICENSE](LICENSE).

## 21. Built By

Original Talli: Estar Kunmi / Kunmiesther.

This repository continues that project and adds the WebMCP Challenge extension.
