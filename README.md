# Agentic Honey-Pot for Scam Detection & Intelligence Extraction

A deterministic REST API that maintains a honeypot-style conversation memory, extracts scam intelligence, scores risk, and generates short anxious replies without ever revealing detection.

## Stack
- Node.js + Express + TypeScript
- dotenv
- In-memory session store (Map) with optional file persistence

## Setup
```bash
npm install
```

Create a `.env` file (you can copy `.env.example`):
```bash
API_KEY=your-secret-key
OPENAI_API_KEY=your-openai-key
LLM_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=2800
PORT=3000
SESSION_PERSIST=false
SESSIONS_FILE=sessions.json
MAX_TURNS=14
```

Run locally:
```bash
npm run dev
```

Build and start:
```bash
npm run build
npm start
```

## Local Test (Exact Steps)
```bash
API_KEY=your-secret-key npm run dev
```

```bash
TEST_URL=http://localhost:3000 API_KEY=your-secret-key npm run test:endpoint
```

## Deployed Test (Exact Steps)
```bash
TEST_URL=https://<render>.onrender.com API_KEY=your-secret-key npm run test:endpoint
```

## GUVI Tester Inputs
- Honeypot API Endpoint URL: `https://<render>.onrender.com/api/honeypot`
- x-api-key: `<API_KEY>`

## OpenAI Writer Layer
- The OpenAI model is used only to phrase replies. Strategy remains deterministic.
- If `OPENAI_API_KEY` is missing or OpenAI times out, the API falls back to the local template writer.
- Keep `OPENAI_TIMEOUT_MS` low for latency (default 2800ms).

## Endpoint
`POST /api/honeypot`

Required header:
- `x-api-key: <API_KEY>`

### Request Body
```json
{
  "sessionId": "...",
  "message": {"sender":"scammer"|"user","text":"...","timestamp":"ISO-8601"},
  "conversationHistory": [{"sender":"...","text":"...","timestamp":"..."}],
  "metadata": {"channel":"SMS|WhatsApp|Email|Chat","language":"...","locale":"IN"}
}
```

### Response Body
```json
{
  "status":"success",
  "sessionId":"...",
  "scamDetected": true,
  "scamScore": 0.82,
  "stressScore": 0.64,
  "engagement": {
    "mode": "SCAM_CONFIRMED",
    "totalMessagesExchanged": 3,
    "agentMessagesSent": 3,
    "scammerMessagesReceived": 3,
    "startedAt": "ISO-8601",
    "lastMessageAt": "ISO-8601"
  },
  "reply":"...",
  "extractedIntelligence": {
    "bankAccounts":["..."],
    "upiIds":["..."],
    "phishingLinks":["..."],
    "phoneNumbers":["..."],
    "emails":["..."],
    "suspiciousKeywords":["urgent","otp"]
  },
  "agentNotes":"..."
}
```

## Curl Example
```bash
curl -X POST http://localhost:3000/api/honeypot \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{
    "sessionId": "demo-001",
    "message": {"sender":"scammer","text":"Your KYC is pending. Share OTP","timestamp":"2026-02-02T12:00:00.000Z"},
    "conversationHistory": [],
    "metadata": {"channel":"SMS","language":"en","locale":"IN"}
  }'
```

## Final Callback
When mode becomes `COMPLETE` (or after `MAX_TURNS`, default 14) and `scamDetected=true`, the service posts to:
- `https://hackathon.guvi.in/api/updateHoneyPotFinalResult`

It retries up to 2 times with a 5s timeout.

## Deployment Notes
- Set `API_KEY` in your hosting environment.
- Set `OPENAI_API_KEY` if you want the OpenAI phrasing layer enabled.
- Ensure outbound HTTPS is allowed for the final callback.
- If you want persistence, set `SESSION_PERSIST=true` and ensure `SESSIONS_FILE` is writable.
- Recommended Node.js 18+ for built-in `fetch`.

## Test Conversation
```bash
API_KEY=your-secret-key npm run test:conversation
```
