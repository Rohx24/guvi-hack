import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.API_KEY || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000/api/honeypot";

async function run() {
  if (!API_KEY) {
    console.error("Missing API_KEY in environment.");
    process.exit(1);
  }

  const sessionId = `demo-${Date.now()}`;
  const messages = [
    {
      sender: "scammer",
      text: "Your KYC is pending. Urgent verify now or account will be blocked. Share OTP.",
      timestamp: new Date().toISOString()
    },
    {
      sender: "scammer",
      text: "Send to UPI: secure@ybl or click https://secure-verify.example.com",
      timestamp: new Date().toISOString()
    },
    {
      sender: "scammer",
      text: "Also call +91 9876543210 if issue.",
      timestamp: new Date().toISOString()
    }
  ];

  for (const msg of messages) {
    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
      },
      body: JSON.stringify({
        sessionId,
        message: msg,
        conversationHistory: [],
        metadata: { channel: "SMS", language: "en", locale: "IN" }
      })
    });

    const payload = await response.json();
    console.log("Reply:", payload.reply);
    console.log("Extracted:", payload.extractedIntelligence);
    console.log("Mode:", payload.engagement.mode, "Score:", payload.scamScore);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
