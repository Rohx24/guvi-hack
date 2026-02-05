import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ExtractedIntelligence } from "./extractor";
import type { EngagementSignals, EngagementStage } from "./planner";
import type { SessionFacts } from "./sessionStore";
import { fetchSimilarExamples } from "./supabase";
import { fallbackReplyForStage, validateReply } from "./validator";
import { safeLog } from "../utils/logging";

export type AuditorInput = {
  sessionId: string;
  lastScammerMessage: string;
  conversationHistory: { sender: string; text: string; timestamp?: string }[];
  extractedIntel: ExtractedIntelligence;
  facts: SessionFacts;
  engagementStage: EngagementStage;
  askedQuestions: Set<string>;
  lastReplies: string[];
  turnIndex: number;
  maxTurns: number;
  scamScore: number;
  stressScore: number;
  signals: EngagementSignals;
  scenario?: string;
  channel?: string;
};

export type AuditorOutput = {
  reply: string;
  chosenIntent: string;
  notes: string;
};

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";

const INTENTS = [
  "ask_ticket_or_case_id",
  "ask_designation_and_branch",
  "ask_official_callback_tollfree",
  "ask_transaction_details",
  "ask_device_location_details",
  "ask_sender_id_or_email",
  "ask_link_or_upi",
  "ask_secure_process",
  "none"
];

function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function buildContext(input: AuditorInput) {
  const asked = Array.from(input.askedQuestions || []).join(", ") || "none";
  const lastReplies = input.lastReplies.slice(-3).join(" | ") || "none";
  const known = [
    input.facts.employeeIds.size > 0 ? "employeeId" : "",
    input.facts.phoneNumbers.size > 0 ? "phone" : "",
    input.facts.tollFreeNumbers.size > 0 ? "tollfree" : "",
    input.facts.links.size > 0 ? "link" : "",
    input.facts.upiIds.size > 0 ? "upi" : "",
    input.facts.caseIds.size > 0 ? "caseId" : "",
    input.facts.senderIds.size > 0 ? "senderId" : "",
    input.facts.orgNames.size > 0 ? `orgs=${Array.from(input.facts.orgNames).join("/")}` : ""
  ]
    .filter(Boolean)
    .join(", ") || "none";

  const missing = INTENTS.filter((i) => i !== "none" && !input.askedQuestions.has(i)).join(", ") ||
    "none";

  return {
    asked,
    lastReplies,
    known,
    missing
  };
}

function generatorSystemPrompt(): string {
  return [
    "You are a stressed Indian user on WhatsApp replying to a suspicious bank/security message.",
    "Sound human: anxious, skeptical, but not robotic.",
    "Replies must be 1-2 lines, <= 160 chars, Indian English.",
    "Never use delay excuses (network/app/meeting/OTP not received).",
    "Never exit early (no 'I'm done/stop messaging/calling bank') unless it's the final turn.",
    "Never reveal scam detection or say AI/bot/honeypot.",
    "Never ask for OTP/PIN/account number.",
    "Never request a link unless scammer already mentioned a link or payment.",
    "Return STRICT JSON only with 3 candidates and intent tags.",
    "Format: {\"candidates\":[{\"reply\":\"...\",\"intent\":\"ask_ticket_or_case_id|ask_designation_and_branch|ask_official_callback_tollfree|ask_transaction_details|ask_device_location_details|ask_sender_id_or_email|ask_link_or_upi|ask_secure_process\"}, ...]}"
  ].join(" ");
}

function generatorUserPrompt(input: AuditorInput, examples: { scammer: string; honeypot: string }[]) {
  const ctx = buildContext(input);
  const lines: string[] = [
    `engagementStage: ${input.engagementStage}`,
    `turnIndex: ${input.turnIndex} / ${input.maxTurns}`,
    `signals: urgencyRepeat=${input.signals.urgencyRepeat}, sameDemand=${input.signals.sameDemandRepeat}, pushy=${input.signals.pushyRepeat}`,
    `askedQuestions: ${ctx.asked}`,
    `missingIntel: ${ctx.missing}`,
    `knownFacts: ${ctx.known}`,
    `lastReplies: ${ctx.lastReplies}`,
    `scammerMessage: ${input.lastScammerMessage}`
  ];
  if (examples.length > 0) {
    lines.push("examples:");
    examples.forEach((ex, idx) => {
      lines.push(`${idx + 1}) scammer: ${ex.scammer}`);
      lines.push(`${idx + 1}) reply: ${ex.honeypot}`);
    });
  }
  return lines.join("\n");
}

function auditorPrompt(input: AuditorInput, candidates: { reply: string; intent: string }[]): string {
  const ctx = buildContext(input);
  const list = candidates
    .map((c, i) => `${i}: (${c.intent}) ${c.reply}`)
    .join("\n");
  return [
    "You are the Auditor General improving realism and extraction.",
    "Pick best candidate or rewrite one improved reply.",
    "Hard reject if: asks OTP/PIN/account, repeats last replies, uses delay excuses, exit lines before final turn, >2 lines, >160 chars, forbidden words (honeypot/ai/bot/scam/fraud).",
    "Rewrite into an extraction question if needed.",
    "Return JSON only: {\"bestIndex\":0|1|2,\"rewrite\":\"...\",\"intent\":\"...\",\"issues\":[...],\"suggestions\":[...]}",
    `engagementStage: ${input.engagementStage}`,
    `turnIndex: ${input.turnIndex} / ${input.maxTurns}`,
    `askedQuestions: ${ctx.asked}`,
    `missingIntel: ${ctx.missing}`,
    `lastReplies: ${ctx.lastReplies}`,
    `scammerMessage: ${input.lastScammerMessage}`,
    `candidates:\n${list}`
  ].join("\n");
}

async function callOpenAIGenerator(
  client: OpenAI,
  model: string,
  input: AuditorInput,
  examples: { scammer: string; honeypot: string }[],
  timeoutMs: number
): Promise<{ reply: string; intent: string }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.responses.create(
      {
        model,
        input: [
          { role: "system", content: generatorSystemPrompt() },
          { role: "user", content: generatorUserPrompt(input, examples) }
        ],
        max_output_tokens: 240,
        temperature: 0.7
      },
      { signal: controller.signal }
    );
    const text = response.output_text?.trim() || "";
    const parsed = extractJson(text);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return candidates
      .map((c: any) => ({ reply: String(c?.reply || "").trim(), intent: String(c?.intent || "none") }))
      .filter((c: { reply: string; intent: string }) => c.reply.length > 0);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAIRevision(
  client: OpenAI,
  model: string,
  input: AuditorInput,
  draft: { reply: string; intent: string },
  issues: string[],
  timeoutMs: number
): Promise<{ reply: string; intent: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.responses.create(
      {
        model,
        input: [
          { role: "system", content: "Return JSON only." },
          {
            role: "user",
            content: [
              "Revise the reply to be human, suspicious, and extraction-focused.",
              "No delay excuses. No exit phrases unless final turn.",
              "Return JSON only: {\"reply\":\"...\",\"intent\":\"...\"}.",
              `engagementStage: ${input.engagementStage}`,
              `turnIndex: ${input.turnIndex} / ${input.maxTurns}`,
              `lastReplies: ${input.lastReplies.slice(-3).join(" | ") || "none"}`,
              `scammerMessage: ${input.lastScammerMessage}`,
              `draftReply: ${draft.reply}`,
              `draftIntent: ${draft.intent}`,
              `issues: ${issues.join("; ") || "none"}`
            ].join("\n")
          }
        ],
        max_output_tokens: 120,
        temperature: 0.5
      },
      { signal: controller.signal }
    );
    const text = response.output_text?.trim() || "";
    const parsed = extractJson(text);
    const reply = typeof parsed?.reply === "string" ? parsed.reply : "";
    const intent = typeof parsed?.intent === "string" ? parsed.intent : "none";
    if (!reply) return null;
    return { reply, intent };
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiAudit(
  input: AuditorInput,
  candidates: { reply: string; intent: string }[],
  timeoutMs: number
): Promise<{ bestIndex: number; rewrite: string; intent: string; issues: string[] } | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) return null;
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });
  const prompt = auditorPrompt(input, candidates);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
  );
  try {
    const result = await Promise.race([model.generateContent(prompt), timeout]);
    const text = result.response.text();
    const parsed = extractJson(text);
    if (!parsed) return null;
    return {
      bestIndex: typeof parsed.bestIndex === "number" ? parsed.bestIndex : -1,
      rewrite: typeof parsed.rewrite === "string" ? parsed.rewrite : "",
      intent: typeof parsed.intent === "string" ? parsed.intent : "none",
      issues: Array.isArray(parsed.issues) ? parsed.issues : []
    };
  } catch {
    return null;
  }
}

function normalizeIntent(intent: string): string {
  const lower = intent.toLowerCase();
  if (INTENTS.includes(lower)) return lower;
  if (lower.includes("ticket") || lower.includes("case") || lower.includes("ref")) return "ask_ticket_or_case_id";
  if (lower.includes("designation") || lower.includes("employee") || lower.includes("branch") || lower.includes("city"))
    return "ask_designation_and_branch";
  if (lower.includes("callback") || lower.includes("toll")) return "ask_official_callback_tollfree";
  if (lower.includes("transaction") || lower.includes("amount") || lower.includes("time")) return "ask_transaction_details";
  if (lower.includes("device") || lower.includes("login") || lower.includes("location")) return "ask_device_location_details";
  if (lower.includes("sender") || lower.includes("email") || lower.includes("domain")) return "ask_sender_id_or_email";
  if (lower.includes("link") || lower.includes("upi")) return "ask_link_or_upi";
  if (lower.includes("process")) return "ask_secure_process";
  return "none";
}

function pickBest(
  input: AuditorInput,
  list: { reply: string; intent: string; source: string }[]
): { reply: string; intent: string; source: string } | null {
  for (const item of list) {
    const intent = normalizeIntent(item.intent);
    const validation = validateReply(item.reply, {
      lastReplies: input.lastReplies,
      engagementStage: input.engagementStage,
      facts: input.facts,
      lastScammerMessage: input.lastScammerMessage,
      turnIndex: input.turnIndex,
      maxTurns: input.maxTurns
    });
    if (validation.ok) {
      return { reply: item.reply, intent, source: item.source };
    }
  }
  return null;
}

function nextLadderQuestion(input: AuditorInput): { key: string; question: string } | null {
  const asked = input.askedQuestions;
  const ladder: Array<{ key: string; question: string; skip?: boolean }> = [
    { key: "ask_ticket_or_case_id", question: "Do you have a ticket or case ID?" },
    { key: "ask_designation_and_branch", question: "Give your designation and branch/city." },
    { key: "ask_official_callback_tollfree", question: "Share the official callback or toll-free number." },
    { key: "ask_transaction_details", question: "What transaction amount and time is this about?" },
    { key: "ask_device_location_details", question: "Which device and location was this login from?" },
    { key: "ask_sender_id_or_email", question: "What is the official SMS sender ID or email domain?" },
    {
      key: "ask_link_or_upi",
      question: "Why are you sending a link or UPI for this?",
      skip:
        input.extractedIntel.phishingLinks.length > 0 ||
        input.extractedIntel.upiIds.length > 0
    },
    { key: "ask_secure_process", question: "Explain the official process without OTP." }
  ];

  for (const item of ladder) {
    if (item.skip) continue;
    if (item.key === "ask_link_or_upi") {
      const hasContext = /link|http|upi|payment|pay/.test(input.lastScammerMessage.toLowerCase()) || input.facts.hasLink || input.facts.hasUpi;
      if (!hasContext) continue;
    }
    if (asked.has(item.key)) continue;
    return item;
  }
  return { key: "ask_secure_process", question: "Explain the official process without OTP." };
}

function ensureQuestion(
  input: AuditorInput,
  reply: string,
  intent: string
): { reply: string; intent: string } {
  if (reply.includes("?")) return { reply, intent };
  const next = nextLadderQuestion(input);
  if (!next) return { reply, intent };
  const candidate = `${reply} ${next.question}`;
  const validation = validateReply(candidate, {
    lastReplies: input.lastReplies,
    engagementStage: input.engagementStage,
    facts: input.facts,
    lastScammerMessage: input.lastScammerMessage,
    turnIndex: input.turnIndex,
    maxTurns: input.maxTurns
  });
  if (validation.ok) return { reply: candidate, intent: next.key };
  return { reply, intent };
}

export async function generateReplyAuditorGeneral(input: AuditorInput): Promise<AuditorOutput> {
  const start = Date.now();
  const budgetMs = Math.min(Number(process.env.COUNCIL_BUDGET_MS || 3500), 6000);
  const llmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS || 2800);
  const enableRevision = process.env.ENABLE_GPT_REVISION !== "false";

  const timeLeft = () => budgetMs - (Date.now() - start);

  const apiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const openai = apiKey ? new OpenAI({ apiKey, timeout: llmTimeoutMs }) : null;

  let examples: { scammer: string; honeypot: string }[] = [];
  if (process.env.ENABLE_SUPABASE_RETRIEVAL === "true" && timeLeft() > 300) {
    const retrievalTimeout = Math.min(500, Math.max(200, timeLeft() - 50));
    try {
      const retrieval = await Promise.race([
        fetchSimilarExamples({
          scenario: input.scenario,
          scammerText: input.lastScammerMessage,
          limit: 3
        }),
        new Promise<{ scammer: string; honeypot: string }[]>((resolve) =>
          setTimeout(() => resolve([]), retrievalTimeout)
        )
      ]);
      examples = retrieval;
    } catch {
      examples = [];
    }
  }

  let candidates: { reply: string; intent: string }[] = [];
  if (openai && timeLeft() > 400) {
    const timeout = Math.min(llmTimeoutMs, Math.max(400, timeLeft() - 100));
    try {
      candidates = await callOpenAIGenerator(openai, openaiModel, input, examples, timeout);
    } catch {
      candidates = [];
    }
  }

  const geminiAudit = timeLeft() > 400 ? await callGeminiAudit(input, candidates, Math.min(llmTimeoutMs, timeLeft() - 100)) : null;

  let revision: { reply: string; intent: string } | null = null;
  if (enableRevision && openai && geminiAudit && timeLeft() > 600) {
    const draft = {
      reply: geminiAudit.rewrite || (candidates[geminiAudit.bestIndex]?.reply || ""),
      intent: geminiAudit.intent || (candidates[geminiAudit.bestIndex]?.intent || "none")
    };
    if (draft.reply) {
      revision = await callOpenAIRevision(
        openai,
        openaiModel,
        input,
        draft,
        geminiAudit.issues,
        Math.min(llmTimeoutMs, timeLeft() - 100)
      );
    }
  }

  const ordered: { reply: string; intent: string; source: string }[] = [];
  if (revision?.reply) ordered.push({ reply: revision.reply, intent: revision.intent, source: "gpt_revision" });
  if (geminiAudit?.rewrite) ordered.push({ reply: geminiAudit.rewrite, intent: geminiAudit.intent, source: "gemini_rewrite" });
  if (geminiAudit && geminiAudit.bestIndex >= 0 && candidates[geminiAudit.bestIndex]) {
    const picked = candidates[geminiAudit.bestIndex];
    ordered.push({ reply: picked.reply, intent: picked.intent, source: "gemini_pick" });
  }
  candidates.forEach((c) => ordered.push({ reply: c.reply, intent: c.intent, source: "gpt_candidate" }));

  const picked = pickBest(input, ordered);
  if (!picked) {
    const fallback = fallbackReplyForStage(input.engagementStage);
    safeLog(`[AUDITOR] ${input.sessionId} ${JSON.stringify({ used: "fallback", turn: input.turnIndex })}`);
    return { reply: fallback, chosenIntent: "none", notes: "fallback" };
  }

  let finalReply = picked.reply;
  let finalIntent = normalizeIntent(picked.intent);
  const ensured = ensureQuestion(input, finalReply, finalIntent);
  finalReply = ensured.reply;
  finalIntent = ensured.intent;

  safeLog(
    `[AUDITOR] ${input.sessionId} ${JSON.stringify({ used: picked.source, turn: input.turnIndex })}`
  );

  return { reply: finalReply, chosenIntent: finalIntent, notes: picked.source };
}
