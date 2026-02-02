import dotenv from "dotenv";

dotenv.config();

const TEST_URL = process.env.TEST_URL;
const API_KEY = process.env.API_KEY;

function missing(field: string): never {
  console.error(`Schema validation failed: missing ${field}`);
  process.exit(1);
}

async function run() {
  if (!TEST_URL) {
    console.error("Missing TEST_URL in environment.");
    process.exit(1);
  }
  if (!API_KEY) {
    console.error("Missing API_KEY in environment.");
    process.exit(1);
  }

  const endpoint = `${TEST_URL.replace(/\/$/, "")}/api/honeypot`;

  const body = {
    sessionId: "test-session-001",
    message: {
      sender: "scammer",
      text: "URGENT: Your SBI account has been compromised. Share OTP now to avoid block in 2 hours.",
      timestamp: new Date().toISOString()
    },
    conversationHistory: [],
    metadata: { channel: "SMS", language: "English", locale: "IN" }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY
    },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  console.log("HTTP status:", response.status);
  console.log("Response JSON:");
  console.log(JSON.stringify(json, null, 2));

  if (json.status === undefined) missing("status");
  if (json.sessionId === undefined) missing("sessionId");
  if (json.scamDetected === undefined) missing("scamDetected");
  if (json.scamScore === undefined) missing("scamScore");
  if (json.stressScore === undefined) missing("stressScore");
  if (json.engagement === undefined) missing("engagement");
  if (json.reply === undefined) missing("reply");
  if (json.extractedIntelligence === undefined) missing("extractedIntelligence");
  if (json.agentNotes === undefined) missing("agentNotes");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
