# Project Title

Talli

# One-line Tagline

Agent-native conversational credit ledger for small businesses and informal traders.

# Short Description

Talli lets people record customer credit in ordinary speech or text while a browser agent reads the same live ledger through WebMCP. The agent can search, summarize, and prepare safe mutations, but the human still confirms the final financial change in the visible Talli UI.

# Full Description

Talli is a credit ledger built for the way small businesses actually keep track of debt: by speaking naturally, not by filling forms.

The original product already handled voice, text, Telegram, persistent customer records, obligations, payments, corrections, aliases, and ambiguity-safe financial state. The WebMCP Challenge extension makes that same live ledger usable by a browser agent through `document.modelContext.registerTool(...)`.

The result is a shared workflow:

1. The agent reads the same state the human sees.
2. The agent prepares a proposed change.
3. Talli validates and resolves the request.
4. Talli shows a visible review card.
5. The human confirms the exact change in Talli.

The production deployment at https://talli-webmcp.onrender.com/ was verified to discover seven WebMCP tools, create proposals, confirm a credit exactly once, clarify ambiguous requests, and keep anonymous browser sessions isolated.

# Why This Is a Strong Fit for WebMCP

Talli is a strong WebMCP use case because the agent is helpful at reading, searching, and preparing financial work, but it should not be trusted to mutate money-related state without a human in the loop.

WebMCP gives Talli a useful boundary:

- the agent can inspect the ledger directly
- the agent can prepare a proposal from the live page context
- the human keeps final control over confirmation

That is collaboration, not automation for its own sake.

# How It Creates a Better User Experience

Talli reduces the work required to manage credit records without forcing the user into a developer-style workflow. A merchant can still speak normally, but now the browser can also help with:

- reading balances
- finding customers
- showing overdue debts
- preparing a proposed payment or settlement for review
- making the human confirmation step visible and explicit

The UI now shows clarification when the request is ambiguous, so Talli avoids silent mistakes.

# What People and Agents Can Do Together That Was Difficult Before

- a person can say "Ada paid 10,000" while the agent checks whether Ada is ambiguous
- the agent can prepare a payment or credit entry without mutating the ledger
- the human can confirm the exact proposal in the visible interface
- the same ledger can be used from the web and Telegram
- the browser can continue to work even when `document.modelContext` is unavailable

# How WebMCP Was Implemented

The browser registers tools imperatively with `document.modelContext.registerTool(...)` when the API is available.

Implementation highlights:

- plain JavaScript frontend
- TypeScript/Node backend
- same-origin JSON endpoints
- strict JSON Schemas with `additionalProperties: false`
- read tools marked `readOnlyHint: true`
- mutation tools marked `readOnlyHint: false`
- untrusted ledger content marked deliberately
- visible proposal state with opaque proposal ids
- human confirmation remains a first-party UI action

# Technologies Used

- TypeScript
- Node.js
- plain JavaScript in the browser
- Supabase/PostgreSQL
- Render
- Telegram Bot API
- Vitest
- Biome
- Zod

# Challenges Encountered

- preventing the browser agent from guessing when customers or obligations are ambiguous
- making proposal confirmation idempotent
- keeping anonymous browser sessions isolated
- aligning browser schemas with the actual service contract
- preserving the existing voice and Telegram behavior while adding WebMCP

# Accomplishments

- browser-native WebMCP tool registration
- seven discoverable tools
- safe proposal/confirmation lifecycle
- visible human review card
- idempotent confirmation
- ambiguity clarification with bounded candidates
- isolated anonymous browser sessions
- production verified Telegram and browser collaboration

# What Was Learned

- financial agents need a strong "do not guess" boundary
- browser-native tools are most useful when they share the exact current page state
- the human confirmation step should be visible and explicit, not hidden behind a generic prompt
- a small, strict tool surface is safer than a broad mutation API

# What's Next

- support more ledger operations only if they can be modeled safely
- improve the collaboration activity feed further
- continue refining the voice-first interaction model
- expand judge-friendly demos and documentation

# Live URL

https://talli-webmcp.onrender.com/

# Repository URL

https://github.com/Kunmiesther/Talli-WebMCP

# Telegram URL

https://t.me/TalliMCP_bot

