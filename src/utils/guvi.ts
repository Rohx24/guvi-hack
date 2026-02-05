import axios from "axios";
import { ExtractedIntel } from "../core/analyst";

const CALLBACK_URL = "https://hackathon.guvi.in/api/updateHoneyPotFinalResult";

export async function sendFinalCallback(params: {
  sessionId: string;
  totalMessagesExchanged: number;
  scamScore: number;
  extracted: ExtractedIntel;
}): Promise<void> {
  const payload = {
    sessionId: params.sessionId,
    scamDetected: params.scamScore >= 0.8,
    totalMessagesExchanged: params.totalMessagesExchanged,
    extractedIntelligence: {
      bankAccounts: params.extracted.bank_accounts,
      upiIds: params.extracted.upi_ids,
      phishingLinks: params.extracted.links,
      phoneNumbers: params.extracted.phone_numbers,
      suspiciousKeywords: []
    },
    agentNotes: "auto_callback"
  };

  const timeout = 5000;
  let attempts = 0;
  while (attempts < 3) {
    try {
      await axios.post(CALLBACK_URL, payload, { timeout });
      return;
    } catch {
      attempts += 1;
    }
  }
}
