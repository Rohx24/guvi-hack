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
  "ask_branch_city",
  "ask_department_name",
  "ask_employee_id",
  "ask_designation",
  "ask_callback_number",
  "ask_escalation_authority",
  "ask_transaction_amount_time",
  "ask_transaction_mode",
  "ask_merchant_receiver",
  "ask_device_type",
  "ask_login_location",
  "ask_ip_or_reason",
  "ask_otp_reason",
  "ask_no_notification_reason",
  "ask_internal_system",
  "ask_phone_numbers",
  "ask_sender_id_or_email",
  "ask_links",
  "ask_upi_or_beneficiary",
  "ask_names_used",
  "ask_keywords_used",
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

function currentPhaseLabel(asked: Set<string>): string {
  const phases: Array<{ label: string; intents: string[] }> = [
    {
      label: "Phase 1",
      intents: ["ask_ticket_or_case_id", "ask_branch_city", "ask_department_name"]
    },
    {
      label: "Phase 2",
      intents: ["ask_employee_id", "ask_designation", "ask_callback_number", "ask_escalation_authority"]
    },
    {
      label: "Phase 3",
      intents: ["ask_transaction_amount_time", "ask_transaction_mode", "ask_merchant_receiver"]
    },
    {
      label: "Phase 4",
      intents: ["ask_device_type", "ask_login_location", "ask_ip_or_reason"]
    },
    {
      label: "Phase 5",
      intents: ["ask_otp_reason", "ask_no_notification_reason", "ask_internal_system"]
    },
    {
      label: "Phase 6",
      intents: ["ask_phone_numbers", "ask_sender_id_or_email", "ask_links", "ask_upi_or_beneficiary", "ask_names_used", "ask_keywords_used"]
    }
  ];
  for (const phase of phases) {
    const pending = phase.intents.some((i) => !asked.has(i));
    if (pending) return phase.label;
  }
  return "Phase 6";
}

function generatorSystemPrompt(): string {
  return [
    "You are a stressed Indian user on WhatsApp replying to a suspicious bank/security message.",
    "Sound human: anxious, skeptical, but not robotic.",
    "Replies must be 1-2 lines, <= 160 chars, Indian English.",
    "Never use delay excuses (network/app/meeting/OTP not received).",
    "Never disengage or exit the conversation.",
    "Never reveal scam detection or say AI/bot/honeypot.",
    "Never ask for OTP/PIN/account number.",
    "Never request a link unless scammer already mentioned a link or payment.",
    "Return STRICT JSON only with 3 candidates and intent tags.",
    "Format: {\"candidates\":[{\"reply\":\"...\",\"intent\":\"ask_ticket_or_case_id|ask_branch_city|ask_department_name|ask_employee_id|ask_designation|ask_callback_number|ask_escalation_authority|ask_transaction_amount_time|ask_transaction_mode|ask_merchant_receiver|ask_device_type|ask_login_location|ask_ip_or_reason|ask_otp_reason|ask_no_notification_reason|ask_internal_system|ask_phone_numbers|ask_sender_id_or_email|ask_links|ask_upi_or_beneficiary|ask_names_used|ask_keywords_used\"}, ...]}"
  ].join(" ");
}

function generatorUserPrompt(input: AuditorInput, examples: { scammer: string; honeypot: string }[]) {
  const ctx = buildContext(input);
  const phase = currentPhaseLabel(input.askedQuestions);
  const lines: string[] = [
    `engagementStage: ${input.engagementStage}`,
    `phase: ${phase}`,
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
  const phase = currentPhaseLabel(input.askedQuestions);
  const list = candidates
    .map((c, i) => `${i}: (${c.intent}) ${c.reply}`)
    .join("\n");
  return [
    "You are the Auditor General improving realism and extraction.",
    "Pick best candidate or rewrite one improved reply.",
    "Hard reject if: asks OTP/PIN/account, repeats last replies, uses delay excuses, any exit lines, >2 lines, >160 chars, forbidden words (honeypot/ai/bot/scam/fraud).",
    "Rewrite into an extraction question if needed.",
    "Return JSON only: {\"bestIndex\":0|1|2,\"rewrite\":\"...\",\"intent\":\"...\",\"issues\":[...],\"suggestions\":[...]}",
    `engagementStage: ${input.engagementStage}`,
    `phase: ${phase}`,
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
  if (lower.includes("branch") || lower.includes("city")) return "ask_branch_city";
  if (lower.includes("department")) return "ask_department_name";
  if (lower.includes("employee id") || lower.includes("emp id")) return "ask_employee_id";
  if (lower.includes("designation")) return "ask_designation";
  if (lower.includes("callback") || lower.includes("toll")) return "ask_callback_number";
  if (lower.includes("escalation") || lower.includes("manager") || lower.includes("supervisor"))
    return "ask_escalation_authority";
  if (lower.includes("transaction") || lower.includes("amount") || lower.includes("time"))
    return "ask_transaction_amount_time";
  if (lower.includes("mode") || lower.includes("imps") || lower.includes("netbanking"))
    return "ask_transaction_mode";
  if (lower.includes("merchant") || lower.includes("receiver")) return "ask_merchant_receiver";
  if (lower.includes("device")) return "ask_device_type";
  if (lower.includes("location") || lower.includes("login") || lower.includes("city"))
    return "ask_login_location";
  if (lower.includes("ip") || lower.includes("unusual")) return "ask_ip_or_reason";
  if (lower.includes("otp reason")) return "ask_otp_reason";
  if (lower.includes("notification") || lower.includes("alert")) return "ask_no_notification_reason";
  if (lower.includes("internal") || lower.includes("system") || lower.includes("flag"))
    return "ask_internal_system";
  if (lower.includes("phone") || lower.includes("number")) return "ask_phone_numbers";
  if (lower.includes("sender") || lower.includes("email") || lower.includes("domain"))
    return "ask_sender_id_or_email";
  if (lower.includes("link")) return "ask_links";
  if (lower.includes("upi") || lower.includes("beneficiary")) return "ask_upi_or_beneficiary";
  if (lower.includes("name")) return "ask_names_used";
  if (lower.includes("keyword")) return "ask_keywords_used";
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
    { key: "ask_branch_city", question: "Which branch or city is this from?" },
    { key: "ask_department_name", question: "Which department is handling this?" },
    { key: "ask_employee_id", question: "What is your employee ID?" },
    { key: "ask_designation", question: "What is your designation?" },
    { key: "ask_callback_number", question: "Share the official callback or toll-free number." },
    { key: "ask_escalation_authority", question: "Who is the escalation authority for this?" },
    { key: "ask_transaction_amount_time", question: "What transaction amount and time is this about?" },
    { key: "ask_transaction_mode", question: "Which mode was used — UPI, IMPS, or netbanking?" },
    { key: "ask_merchant_receiver", question: "Who is the merchant or receiver name?" },
    { key: "ask_device_type", question: "Which device type was used?" },
    { key: "ask_login_location", question: "Which city/location was this login from?" },
    { key: "ask_ip_or_reason", question: "Why was this login flagged as unusual?" },
    { key: "ask_otp_reason", question: "Why do you need OTP for this?" },
    { key: "ask_no_notification_reason", question: "Why didn't the app show any alert?" },
    { key: "ask_internal_system", question: "Which internal system flagged this?" },
    { key: "ask_phone_numbers", question: "Which official number are you calling from?" },
    { key: "ask_sender_id_or_email", question: "What is the official SMS sender ID or email domain?" },
    {
      key: "ask_links",
      question: "Why are you sending a link for this?",
      skip: input.extractedIntel.phishingLinks.length > 0
    },
    { key: "ask_upi_or_beneficiary", question: "Give the UPI ID or beneficiary name." },
    { key: "ask_names_used", question: "What name was used in your system?" },
    { key: "ask_keywords_used", question: "Which keywords or alerts were triggered?" }
  ];

  for (const item of ladder) {
    if (item.skip) continue;
    if (item.key === "ask_links") {
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
  const budgetMs = Math.min(Number(process.env.COUNCIL_BUDGET_MS || 2000), 2000);
  const llmTimeoutMs = Math.min(Number(process.env.LLM_TIMEOUT_MS || 1800), Math.max(600, budgetMs - 100));
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
