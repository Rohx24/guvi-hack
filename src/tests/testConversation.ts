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
      text: "Your SBI account is blocked. Urgent verify now. Share OTP.",
      timestamp: new Date().toISOString()
    },
    {
      sender: "scammer",
      text: "This is SBI fraud team, Mumbai branch. Ref ID REF1234.",
      timestamp: new Date().toISOString()
    },
    {
      sender: "scammer",
      text: "No time. OTP needed now. Also Delhi branch will close your account.",
      timestamp: new Date().toISOString()
    },
    {
      sender: "scammer",
      text: "Click https://sbi-verify.example.com to secure it.",
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
    console.log("Status:", payload.status);
    console.log("Reply:", payload.reply);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
