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
    },
    {
      sender: "scammer",
      text: "You must do now or account will freeze in 2 hours. Share OTP.",
      timestamp: new Date().toISOString()
    },
    {
      sender: "scammer",
      text: "Why delay? Complete the verification quickly.",
      timestamp: new Date().toISOString()
    }
  ];

  const history: { sender: string; text: string; timestamp: string }[] = [];
  const replies: string[] = [];
  let pushbackSeen = false;

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
      },
      body: JSON.stringify({
        sessionId,
        message: msg,
        conversationHistory: history,
        metadata: { channel: "SMS", language: "en", locale: "IN" }
      })
    });

    const payload = await response.json();
    console.log("Reply:", payload.reply);
    console.log("Extracted:", payload.extractedIntelligence);
    console.log("Mode:", payload.engagement.mode, "Score:", payload.scamScore);

    const reply = String(payload.reply || "");
    replies.push(reply);

    if (i < 2 && /(send|share|resend).*(upi|link)|upi id|payment link/i.test(reply)) {
      console.error("Test failed: asked for UPI/link in first two replies.");
      process.exit(1);
    }

    if (payload.extractedIntelligence?.upiIds?.length > 0 || payload.extractedIntelligence?.phishingLinks?.length > 0) {
      if (/(send|share|resend).*(upi|link)|upi id|payment link/i.test(reply)) {
        console.error("Test failed: asked to send UPI/link again after extraction.");
        process.exit(1);
      }
    }

    if (/[?]/.test(reply) || /why|odd|different|not how/i.test(reply.toLowerCase())) {
      pushbackSeen = true;
    }

    if (replies.length >= 3) {
      const last3 = replies.slice(-3);
      const uniq = new Set(last3);
      if (uniq.size < last3.length) {
        console.error("Test failed: repeated reply across 3 turns.");
        process.exit(1);
      }
    }

    history.push(msg);
  }

  if (!pushbackSeen) {
    console.error("Test failed: no pushback response detected within 6 turns.");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
