import { pickBestCandidate } from "./rubric";
import { generateOpenAICandidates } from "./providers/openaiClient";
import { generateGeminiImproved } from "./providers/geminiClient";
import { safeLog } from "../utils/logging";

export type CouncilInput = {
  sessionId: string;
  lastScammerMessage: string;
  conversationHistory: { sender: string; text: string; timestamp?: string }[];
  extractedIntel: {
    bankAccounts: string[];
    upiIds: string[];
    phishingLinks: string[];
    phoneNumbers: string[];
    suspiciousKeywords: string[];
  };
  lastReplies: string[];
  turnCount: number;
  scamScore: number;
  stressScore: number;
  storySummary: string;
};

type CouncilOutput = {
  reply: string;
  agentNotes: string;
};

const FALLBACK_REPLIES_LOW = [
  "I'm not sure. Can you confirm your employee ID?",
  "My app shows an error. I'll check and reply.",
  "I'm in a meeting. I'll call the bank helpline first."
];

const FALLBACK_REPLIES_HIGH = [
  "Wait, why OTP here? I'm getting scared.",
  "This feels risky. I'll call SBI now.",
  "This feels off. Please share your employee ID."
];

function deterministicPick(pool: string[], seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  }
  return pool[hash % pool.length];
}

function fallbackReply(input: CouncilInput): CouncilOutput {
  const pool = input.stressScore >= 0.6 ? FALLBACK_REPLIES_HIGH : FALLBACK_REPLIES_LOW;
  const reply = deterministicPick(pool, `${input.sessionId}:${input.turnCount}`);
  return { reply, agentNotes: "council=fallback" };
}

export async function generateReplyCouncil(input: CouncilInput): Promise<CouncilOutput> {
  const councilEnabled = process.env.COUNCIL_MODE === "true";
  if (!councilEnabled) {
    return fallbackReply(input);
  }
  const openaiTimeout = 1000;
  const geminiTimeout = 1000;
  const gptPromise = generateOpenAICandidates(input, openaiTimeout);
  const geminiPromise = generateGeminiImproved(input, [], geminiTimeout);

  const [gptRes, gemRes] = await Promise.allSettled([gptPromise, geminiPromise]);

  const candidates: string[] = [];
  let used: "gpt" | "gemini" | "both" | "fallback" = "fallback";

  if (gptRes.status === "fulfilled") {
    candidates.push(...gptRes.value.candidates);
    used = "gpt";
  }
  if (gemRes.status === "fulfilled") {
    if (gemRes.value.improved) {
      candidates.push(gemRes.value.improved);
      used = used === "gpt" ? "both" : "gemini";
    }
    if (gptRes.status === "fulfilled" && gemRes.value.pick >= 0) {
      const picked = gptRes.value.candidates[gemRes.value.pick];
      if (picked) candidates.push(picked);
    }
  }

  const best = pickBestCandidate(candidates, {
    lastScammerMessage: input.lastScammerMessage,
    lastReplies: input.lastReplies
  });

  if (!best) {
    const fallback = fallbackReply(input);
    safeLog(`[COUNCIL] ${input.sessionId} ${JSON.stringify({ used: "fallback", turnCount: input.turnCount })}`);
    return fallback;
  }

  safeLog(
    `[COUNCIL] ${input.sessionId} ${JSON.stringify({ used, turnCount: input.turnCount })}`
  );

  return {
    reply: best.reply,
    agentNotes: `council=${used},score=${best.score}`
  };
}
