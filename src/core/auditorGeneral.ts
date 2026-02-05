import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ExtractedIntelligence } from "./extractor";
import type { PersonaStage, PersonaSignals } from "./planner";
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
  personaStage: PersonaStage;
  askedQuestions: Set<string>;
  lastReplies: string[];
  turnIndex: number;
  scamScore: number;
  stressScore: number;
  signals: PersonaSignals;
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
  "reference",
  "designation",
  "branch",
  "callback",
  "transaction",
  "device",
  "link",
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

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildContext(input: AuditorInput) {
  const asked = Array.from(input.askedQuestions || []).join(", ") || "none";
  const lastReplies = input.lastReplies.slice(-3).join(" | ") || "none";
  const known = [
    input.facts.employeeIds.size > 0 ? "employeeId" : "",
    input.facts.phoneNumbers.size > 0 ? "phone" : "",
    input.facts.links.size > 0 ? "link" : "",
    input.facts.upiIds.size > 0 ? "upi" : "",
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
    "You must sound human: anxious, slightly messy, not robotic.",
    "Replies must be 1-2 lines, <= 140 chars, Indian English.",
    "Never reveal scam detection or say AI/bot/honeypot.",
    "Never ask for OTP/PIN/account number.",
    "Never request a link unless scammer already mentioned a link or payment.",
    "Return STRICT JSON only with 3 candidates and intent tags.",
    "Format: {\"candidates\":[{\"reply\":\"...\",\"intent\":\"reference|designation|branch|callback|transaction|device|link|none\"}, ...]}"
  ].join(" ");
}

function generatorUserPrompt(input: AuditorInput, examples: { scammer: string; honeypot: string }[]) {
  const ctx = buildContext(input);
  const lines: string[] = [
    `personaStage: ${input.personaStage}`,
    `turnIndex: ${input.turnIndex}`,
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
    "You are the Auditor General improving realism and safety.",
    "Pick best candidate or rewrite one improved reply.",
    "Hard reject if: asks OTP/PIN/account, repeats last replies, too polite for stage, >2 lines, >140 chars, contains forbidden words (honeypot/ai/bot/scam/fraud).",
    "Return JSON only: {\"bestIndex\":0|1|2,\"rewrite\":\"...\",\"intent\":\"...\",\"issues\":[...],\"suggestions\":[...]}",
    `personaStage: ${input.personaStage}`,
    `askedQuestions: ${ctx.asked}`,
    `missingIntel: ${ctx.missing}`,
    `lastReplies: ${ctx.lastReplies}`,
    `scammerMessage: ${input.lastScammerMessage}`,
    `candidates:\n${list}`
  ].join("\n");
}

function revisionPrompt(input: AuditorInput, draft: { reply: string; intent: string }, issues: string[]) {
  const ctx = buildContext(input);
  return [
    "You are revising a WhatsApp reply for realism and safety.",
    "Reply must be 1-2 lines, <= 140 chars, Indian English.",
    "Never ask for OTP/PIN/account number. Never mention AI/bot/scam/honeypot.",
    "Return JSON only: {\"reply\":\"...\",\"intent\":\"reference|designation|branch|callback|transaction|device|link|none\"}",
    `personaStage: ${input.personaStage}`,
    `askedQuestions: ${ctx.asked}`,
    `missingIntel: ${ctx.missing}`,
    `lastReplies: ${ctx.lastReplies}`,
    `scammerMessage: ${input.lastScammerMessage}`,
    `draftReply: ${draft.reply}`,
    `draftIntent: ${draft.intent}`,
    `issues: ${issues.join("; ") || "none"}`
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
          { role: "user", content: revisionPrompt(input, draft, issues) }
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
  if (lower.includes("reference") || lower.includes("ticket")) return "reference";
  if (lower.includes("designation") || lower.includes("employee")) return "designation";
  if (lower.includes("branch") || lower.includes("city")) return "branch";
  if (lower.includes("callback") || lower.includes("toll")) return "callback";
  if (lower.includes("transaction") || lower.includes("amount")) return "transaction";
  if (lower.includes("device") || lower.includes("login")) return "device";
  if (lower.includes("link")) return "link";
  return "none";
}

function pickBest(
  input: AuditorInput,
  list: { reply: string; intent: string; source: string }[]
): { reply: string; intent: string; source: string; reason?: string } | null {
  for (const item of list) {
    const intent = normalizeIntent(item.intent);
    const validation = validateReply(item.reply, {
      lastReplies: input.lastReplies,
      personaStage: input.personaStage,
      facts: input.facts,
      lastScammerMessage: input.lastScammerMessage
    });
    if (validation.ok) {
      return { reply: item.reply, intent, source: item.source };
    }
  }
  return null;
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
        { reply: draft.reply, intent: draft.intent },
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
    const fallback = fallbackReplyForStage(input.personaStage);
    safeLog(`[AUDITOR] ${input.sessionId} ${JSON.stringify({ used: "fallback", turn: input.turnIndex })}`);
    return { reply: fallback, chosenIntent: "none", notes: "fallback" };
  }

  safeLog(
    `[AUDITOR] ${input.sessionId} ${JSON.stringify({ used: picked.source, turn: input.turnIndex })}`
  );

  return { reply: picked.reply, chosenIntent: normalizeIntent(picked.intent), notes: picked.source };
}
