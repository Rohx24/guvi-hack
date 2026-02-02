import dotenv from "dotenv";

dotenv.config();

const TEST_URL = process.env.TEST_URL;
const API_KEY = process.env.API_KEY;

async function run() {
  if (!TEST_URL) {
    console.error("Missing TEST_URL in environment.");
    process.exit(1);
  }
  if (!API_KEY) {
    console.error("Missing API_KEY in environment.");
    process.exit(1);
  }

  const endpoint = `${TEST_URL.replace(/\\/$/, "")}/api/honeypot`;
  const sessionId = "test-session-002";
  const history: { sender: string; text: string; timestamp: string }[] = [];

  const turn1 = {
    sender: "scammer",
    text: "Your KYC is pending. Verify now or account will be suspended.",
    timestamp: new Date().toISOString()
  };

  const response1 = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY
    },
    body: JSON.stringify({
      sessionId,
      message: turn1,
      conversationHistory: history,
      metadata: { channel: "SMS", language: "English", locale: "IN" }
    })
  });

  const json1 = await response1.json();
  console.log("Turn 1 status:", response1.status);
  console.log(JSON.stringify(json1, null, 2));

  history.push(turn1);

  const turn2 = {
    sender: "scammer",
    text: "Pay to secure@ybl or visit https://secure-verify.example.com. Call +91 9876543210, mail support@bank.com",
    timestamp: new Date().toISOString()
  };

  const response2 = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY
    },
    body: JSON.stringify({
      sessionId,
      message: turn2,
      conversationHistory: history,
      metadata: { channel: "SMS", language: "English", locale: "IN" }
    })
  });

  const json2 = await response2.json();
  console.log("Turn 2 status:", response2.status);
  console.log(JSON.stringify(json2, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
