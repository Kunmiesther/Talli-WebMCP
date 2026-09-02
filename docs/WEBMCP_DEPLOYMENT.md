# Talli WebMCP Deployment

This repository is ready to deploy as a separate Render web service named `talli-webmcp`.

## Runtime

- Render runtime: Node web service
- Build command: `npm run build`
- Start command: `npm run start`
- Health check path: `/api/health`
- HTTPS: provided by Render

The app already serves the browser assets and API from the same origin. The production responses already include:

- `Origin-Agent-Cluster: ?1`
- `Permissions-Policy: tools=(self)`

## Storage Recommendation

Use Supabase for this deployment.

Why:

- Session data, ledger events, and proposal state are all keyed by session/user ID.
- Sharing a Supabase project with the original Micro1 deployment can collide on the same keys and leak or overwrite state.
- The code does not namespace records per deployment automatically.

Recommended setup:

1. Create a separate Supabase project for this Render deployment.
2. Set `TALLI_STORAGE_DRIVER=supabase`.
3. Set the Supabase service-role connection variables in Render.

Do not reuse the original Micro1 Supabase credentials unless you explicitly intend to share state.

If you use file storage temporarily instead, remember that Render web-service filesystems are ephemeral unless you add persistent disk. Data can be lost on restart or redeploy.

## Required Render Variables

Set these in Render’s environment settings:

- `SESSION_SECRET`
- `TALLI_STORAGE_DRIVER` `= supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Optional LLM Variables

These are only needed if you want model-backed interpretation or transcription:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`
- `TRANSCRIPTION_API_KEY`
- `TRANSCRIPTION_MODEL`
- `TRANSCRIPTION_BASE_URL`
- `TALLI_INTERPRETER_MODE`

## Optional Non-LLM Variables

These are safe to leave unset on Render because the app already has defaults:

- `TALLI_TIMEZONE`

Render already provides `PORT`, and the server binds to `0.0.0.0` by default.

## Variables That Must Not Be Copied From Micro1 Without Review

Do not blindly copy these from the original deployment:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `TALLI_PUBLIC_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Local-Only Variables

These are for local file-backed runs only:

- `TALLI_DATA_DIR`
- `TALLI_LEDGER_FILE`
- `TALLI_STATE_FILE`
- `TALLI_AUTH_FILE`
- `TALLI_HOST`
- `TALLI_PORT`

## Telegram Variables To Omit For This Deployment

Leave these unset for the WebMCP Challenge deployment:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `TALLI_PUBLIC_URL`

The server only starts Telegram integrations when the Telegram token is configured, so omitting these variables keeps the deployment web-only.

## Render Dashboard Steps

1. Create a new Render Web Service from this repository and branch.
2. Keep the instance count at 1.
3. Use the `render.yaml` blueprint or enter the same values manually.
4. Set `SESSION_SECRET` to a new random secret.
5. Set the Supabase variables for the separate project.
6. Leave Telegram variables unset.
7. Add any optional LLM variables only if you need them.
8. Deploy and verify `GET /api/health`.

## Notes

- Do not commit secrets.
- Enter secrets only in Render’s environment settings.
- The visible browser WebMCP flow will register tools when `document.modelContext` exists.
- No origin-trial token is included yet because the final Render hostname is not known.
