import { ExtractedIntelligence } from "./extractor";

export type FinalCallbackPayload = {
  sessionId: string;
  scamDetected: true;
  totalMessagesExchanged: number;
  extractedIntelligence: {
    bankAccounts: string[];
    upiIds: string[];
    phishingLinks: string[];
    phoneNumbers: string[];
    suspiciousKeywords: string[];
  };
  agentNotes: string;
};

const CALLBACK_URL = "https://hackathon.guvi.in/api/updateHoneyPotFinalResult";

async function postWithTimeout(url: string, payload: FinalCallbackPayload, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendFinalCallback(
  sessionId: string,
  totalMessagesExchanged: number,
  extracted: ExtractedIntelligence,
  agentNotes: string
): Promise<{ ok: boolean; status?: number }> {
  const payload: FinalCallbackPayload = {
    sessionId,
    scamDetected: true,
    totalMessagesExchanged,
    extractedIntelligence: {
      bankAccounts: extracted.bankAccounts,
      upiIds: extracted.upiIds,
      phishingLinks: extracted.phishingLinks,
      phoneNumbers: extracted.phoneNumbers,
      suspiciousKeywords: extracted.suspiciousKeywords
    },
    agentNotes
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await postWithTimeout(CALLBACK_URL, payload, 5000);
      if (response.ok) {
        return { ok: true, status: response.status };
      }
      lastError = new Error(`Callback failed with status ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  return { ok: false, status: lastError instanceof Error ? undefined : undefined };
}
