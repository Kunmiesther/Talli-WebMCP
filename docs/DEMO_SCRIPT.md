# Talli WebMCP Demo Script

Target length: 2:35 to 2:45.

## Pre-recording Checklist

- clean browser profile or incognito window
- seeded customers and exact amounts ready
- Render deployment awake
- Telegram connected to `@TalliMCP_bot`
- browser zoom set for readability
- microphone working
- system notifications hidden
- no secrets visible in any tab
- backup recording plan ready

## Script

### 0:00 - 0:12

**Narration:** "Talli is a credit ledger for real people who keep track of debt by speaking naturally. Now the browser can help read and prepare the same live ledger, but the human still confirms the final change."

**On screen:** Start on the live Talli page. Show the dashboard and the human review area.

### 0:12 - 0:28

**Narration:** "This page exposes WebMCP tools directly in the browser when the model context is available."

**On screen:** Open the browser agent or tool inspector and show that Talli discovers its tools.

### 0:28 - 0:42

**Narration:** "First, I ask for a ledger summary."

**On screen:** Run `get_ledger_summary`. Show the compact JSON result and the visible ledger summary card.

### 0:42 - 1:08

**Narration:** "Next, I prepare a credit entry. Talli validates it and creates a proposal, but the ledger does not change yet."

**On screen:** Run `prepare_ledger_mutation` for a credit. Show the visible proposal card with the summary and the Confirm button. Pause on the unchanged ledger total.

### 1:08 - 1:22

**Narration:** "Now I confirm it in the visible Talli interface. The same proposal applies exactly once."

**On screen:** Click Confirm. Show the success state and the updated ledger balance.

### 1:22 - 1:48

**Narration:** "Here is the safety check. Ada is ambiguous, so Talli refuses to guess."

**On screen:** Prepare a payment for Ada. Show `clarification_required`, three bounded candidates, and the unchanged ledger total.

**Narration:** "No Confirm button appears because no executable proposal exists."

### 1:48 - 2:08

**Narration:** "Talli also works with Telegram, so the same ledger can be used from chat."

**On screen:** Show the connected Telegram state and a brief message or linked status. Keep this short.

### 2:08 - 2:30

**Narration:** "WebMCP makes the browser an agent-native control surface for the same live financial state. The agent can read and prepare safely, but the person still owns the final money-changing decision."

**On screen:** Return to the proposal review area and the collaboration activity feed.

### 2:30 - 2:42

**Narration:** "That is Talli: a conversational ledger that stays safe, visible, and shared across person, browser agent, and Telegram."

**On screen:** End on the main dashboard with the live URL visible.

