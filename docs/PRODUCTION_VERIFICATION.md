# Production Verification

This document records verified facts only.

## Live Verification

Verified production URL:

- https://talli-webmcp.onrender.com/

Verified facts from the live deployment:

- production health returned HTTP 200
- the browser received the required WebMCP headers
- the WebMCP script was served as JavaScript
- ChatGPT's browser discovered exactly seven WebMCP tools
- `get_ledger_summary` executed successfully
- `prepare_ledger_mutation` returned a visible proposal without changing the ledger
- human confirmation updated a `65,000` credit exactly once
- an ambiguous "Ada paid 10,000" request returned `clarification_required`
- the ambiguity response used `AMBIGUOUS_CUSTOMER`
- the ambiguity response returned three bounded candidates
- the ledger total stayed at `150,000` before and after the ambiguity
- Telegram webhook and messaging worked through `@TalliMCP_bot`
- anonymous browser sessions were isolated after the fix

## Automated Tests

Repository tests also cover:

- mutation proposal lifecycle
- browser WebMCP tool registration
- strict schema validation
- proposal workbench state handling
- Telegram webhook and linking behavior
- session isolation
- public frontend source checks

## Live vs Automated

- Live verification proves the behavior observed in the deployed production service.
- Automated tests prove the expected implementation behavior in the repository.
- The two are related but not interchangeable.

