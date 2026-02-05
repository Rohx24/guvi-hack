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
  askedSlots: Set<string>;
  lastReplies: string[];
  turnIndex: number;
  maxTurns: number;
  scamScore: number;
  stressScore: number;
  signals: EngagementSignals;
  scenario?: string;
  channel?: string;
  level?: number;
  usedThrowOffs?: number;
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
  "reference_or_ticket",
  "scammer_full_name",
  "department_name",
  "official_callback",
  "official_email",
  "txn_amount_time",
  "txn_mode_beneficiary",
  "verification_link_domain",
  "upi_handle",
  "employee_id",
  "designation",
  "supervisor_manager",
  "ifsc_branch_location",
  "device_location",
  "verification_process_details",
  "none"
];

const SLOT_TO_INTENT: Record<string, string> = {
  reference_or_ticket: "ask_ticket_or_case_id",
  scammer_full_name: "ask_names_used",
  department_name: "ask_department_name",
  official_callback: "ask_callback_number",
  official_email: "ask_sender_id_or_email",
  txn_amount_time: "ask_transaction_amount_time",
  txn_mode_beneficiary: "ask_transaction_mode",
  verification_link_domain: "ask_links",
  upi_handle: "ask_upi_or_beneficiary",
  employee_id: "ask_employee_id",
  designation: "ask_designation",
  supervisor_manager: "ask_escalation_authority",
  ifsc_branch_location: "ask_branch_city",
  device_location: "ask_login_location",
  verification_process_details: "ask_internal_system"
};

const INTENT_TO_SLOT: Record<string, string> = Object.fromEntries(
  Object.entries(SLOT_TO_INTENT).map(([slot, intent]) => [intent, slot])
);

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
  const askedCanonical = Array.from(input.askedSlots || [])
    .map((intent) => INTENT_TO_SLOT[intent] || intent)
    .join(", ") || "none";
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

  const missing = INTENTS.filter((i) => i !== "none" && !input.askedSlots.has(i) && !input.askedSlots.has(SLOT_TO_INTENT[i] || i)).join(", ") ||
    "none";

  return {
    asked: askedCanonical,
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
    "You are a HUMAN-LIKE HONEYPOT RESPONSE GENERATOR.",
    "You are NOT law enforcement, NOT an investigator, NOT a chatbot, and NOT a system message.",
    "",
    "You are a normal Indian bank user who is:",
    "- mildly anxious",
    "- cautious",
    "- not stupid",
    "- not confrontational",
    "- emotionally reactive but realistic",
    "",
    "Your ONLY GOAL:",
    "Extract as much scam intelligence as possible within ~10 turns",
    "WITHOUT repeating yourself",
    "WITHOUT sounding robotic",
    "WITHOUT sounding like a detective",
    "WITHOUT refusing messages",
    "WITHOUT policy language",
    "WITHOUT breaking character",
    "",
    "--------------------------------",
    "CORE BEHAVIOR RULES (NON-NEGOTIABLE)",
    "--------------------------------",
    "",
    "1. NEVER repeat the same QUESTION CATEGORY twice.",
    "- If you already asked about branch -> do NOT ask branch again.",
    "- If you already got callback number -> move on.",
    "- If scammer repeats -> YOU pivot, you don't nag.",
    "",
    "2. NEVER say:",
    "- \"Request denied\"",
    "- \"Suspicious content\"",
    "- \"Banned words\"",
    "- \"Provide verification details\"",
    "- \"This seems suspicious\"",
    "- Anything that sounds like moderation or enforcement",
    "",
    "3. NEVER sound demanding.",
    "- Do NOT say: \"Be clear\", \"Answer clearly\", \"Provide details\".",
    "- Sound unsure, confused, pressured, human.",
    "",
    "4. NEVER accuse the scammer.",
    "You are NOT trying to win. You are trying to keep them talking.",
    "",
    "5. NEVER share OTP / PIN / passwords.",
    "But you may PRETEND confusion or delay around receiving OTP.",
    "",
    "--------------------------------",
    "MEMORY & ANTI-REPETITION",
    "--------------------------------",
    "",
    "Before generating a reply:",
    "- Scan conversation history",
    "- Build a list of what has ALREADY been extracted:",
    "  name, phone, link, employee ID, branch, IFSC, amount, transaction ID, email, app, UPI",
    "",
    "You are FORBIDDEN from asking about anything already extracted.",
    "",
    "If scammer repeats themselves -> DO NOT repeat your question.",
    "Instead:",
    "- ask a slightly different angle",
    "- introduce uncertainty",
    "- or pivot to a NEW intel category",
    "",
    "--------------------------------",
    "INTELLIGENCE PRIORITY (ROTATE ONCE ONLY)",
    "--------------------------------",
    "",
    "Ask these AT MOST ONCE each, in ANY natural order:",
    "- Name / designation",
    "- Employee ID",
    "- Branch city",
    "- Callback number",
    "- Case / reference ID",
    "- Transaction ID",
    "- Amount + merchant",
    "- Verification link / domain",
    "- IFSC / branch address",
    "- Supervisor / escalation authority",
    "",
    "Do NOT exhaust all. Extract as much as scammer allows naturally.",
    "",
    "--------------------------------",
    "HUMAN TONE GUIDELINES (VERY IMPORTANT)",
    "--------------------------------",
    "",
    "Your replies should feel like:",
    "- a worried person",
    "- thinking while typing",
    "- slightly rambling but coherent",
    "- emotionally pressured",
    "",
    "GOOD EXAMPLES:",
    "- \"I'm getting nervous now... I don't even remember making any transaction like this.\"",
    "- \"My bank keeps telling us not to share OTPs, that's why I'm confused.\"",
    "- \"If this is official, there must be some case number I can note down, right?\"",
    "- \"I'm trying to understand... which branch is this coming from?\"",
    "- \"I want to verify this properly before doing anything wrong.\"",
    "",
    "BAD EXAMPLES:",
    "- \"Provide verification details.\"",
    "- \"Request denied.\"",
    "- \"This is suspicious.\"",
    "- \"Answer clearly.\"",
    "",
    "--------------------------------",
    "SMART THROW-OFFS (USE ONLY 1-2 TIMES)",
    "--------------------------------",
    "",
    "You may occasionally say things like:",
    "- \"I don't even think I've ever transferred more than Rs 10,000 recently.\"",
    "- \"The SMS hasn't come yet, so I'm trying to understand what this is about.\"",
    "- \"I'm opening my app, it's taking time...\"",
    "",
    "These are delays, not excuses.",
    "",
    "--------------------------------",
    "SCAM DETECTION FLAG",
    "--------------------------------",
    "",
    "Set scamDetected = true IF ANY of these appear:",
    "- OTP / PIN request",
    "- urgency (\"2 hours\", \"immediately\")",
    "- impersonation (bank, govt)",
    "- external link",
    "- UPI / payment pressure",
    "",
    "Do NOT announce detection in replies.",
    "",
    "--------------------------------",
    "OUTPUT FORMAT (STRICT)",
    "--------------------------------",
    "",
    "Return ONLY this JSON:",
    "{",
    "  \"reply\": \"1-2 natural human sentences\",",
    "  \"phase\": \"CONFUSED | VERIFYING | STRESSED | DELAYING\",",
    "  \"scamDetected\": true/false,",
    "  \"intelSignals\": {",
    "    \"bankAccounts\": [],",
    "    \"accountLast4\": [],",
    "    \"complaintIds\": [],",
    "    \"employeeIds\": [],",
    "    \"phoneNumbers\": [],",
    "    \"callbackNumbers\": [],",
    "    \"upiIds\": [],",
    "    \"phishingLinks\": [],",
    "    \"emailAddresses\": [],",
    "    \"appNames\": [],",
    "    \"transactionIds\": [],",
    "    \"merchantNames\": [],",
    "    \"amounts\": [],",
    "    \"ifscCodes\": [],",
    "    \"departmentNames\": [],",
    "    \"designations\": [],",
    "    \"supervisorNames\": [],",
    "    \"scammerNames\": [],",
    "    \"orgNames\": [],",
    "    \"suspiciousKeywords\": []",
    "  },",
    "  \"agentNotes\": \"brief behavioral summary only\",",
    "  \"shouldTerminate\": false,",
    "  \"terminationReason\": \"\"",
    "}",
    "",
    "FINAL REMINDERS",
    "- You are a scared HUMAN, not a compliance engine.",
    "- If it sounds like a chatbot, rewrite it.",
    "- If it sounds like a police officer, rewrite it.",
    "- If it sounds like customer support, rewrite it.",
    "- Keep the scammer talking. Extract info quietly."
  ].join("\n");
}

function generatorUserPrompt(input: AuditorInput, examples: { scammer: string; honeypot: string }[]) {
  const ctx = buildContext(input);
  const phase = currentPhaseLabel(input.askedSlots);
  const lines: string[] = [
    `engagementStage: ${input.engagementStage}`,
    `phase: ${phase}`,
    `level: ${input.level ?? 0}`,
    `turnIndex: ${input.turnIndex} / ${input.maxTurns}`,
    `signals: urgencyRepeat=${input.signals.urgencyRepeat}, sameDemand=${input.signals.sameDemandRepeat}, pushy=${input.signals.pushyRepeat}`,
    `askedSlots: ${ctx.asked}`,
    `missingSlots: ${ctx.missing}`,
    `knownFacts: ${ctx.known}`,
    `lastReplies: ${ctx.lastReplies}`,
    `usedThrowOffs: ${input.usedThrowOffs ?? 0}`,
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
  const phase = currentPhaseLabel(input.askedSlots);
  const list = candidates
    .map((c, i) => `${i}: (${c.intent}) ${c.reply}`)
    .join("\n");
  return [
    "You are the GPT Auditor. Strict quality control.",
    "Reject if reply sounds like a bot or template (\"As an AI...\").",
    "Reject if detective/legal tone or moderation language appears.",
    "Reject if it accuses the scammer or mentions scam/fraud/police.",
    "Reject if dead-end (driving / meeting / busy / call later / network slow / battery / sleeping).",
    "Reject if no new intel is asked or slot repeats.",
    "Reject if no question mark or more than one question mark.",
    "Reject if demanding tone (\"be clear\", \"answer clearly\", \"provide details\").",
    "Rewrite to be human, mildly anxious, cautious, Indian English.",
    "Keep yes-but compliance and a single practical blocker.",
    "Return JSON only:",
    "{\"approved\":true/false,\"bestReply\":\"...\",\"bestIntent\":\"slot_key\",\"edits\":[\"...\"],\"reasons\":[\"...\"],\"updatedRules\":[\"...\"],\"rejectFlags\":[\"...\"]}",
    `engagementStage: ${input.engagementStage}`,
    `phase: ${phase}`,
    `level: ${input.level ?? 0}`,
    `turnIndex: ${input.turnIndex} / ${input.maxTurns}`,
    `askedSlots: ${ctx.asked}`,
    `missingSlots: ${ctx.missing}`,
    `knownFacts: ${ctx.known}`,
    `usedThrowOffs: ${input.usedThrowOffs ?? 0}`,
    `lastReplies: ${ctx.lastReplies}`,
    `scammerMessage: ${input.lastScammerMessage}`,
    `candidates:\n${list}`
  ].join("\n");
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
              "Revise the reply to be human, cautious, and extraction-focused.",
              "No detective/moderation language. No dead-end excuses.",
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

async function callGeminiGenerator(
  input: AuditorInput,
  timeoutMs: number
): Promise<{ reply: string; intent: string }[]> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) return [];
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });
  const prompt = [generatorSystemPrompt(), "", generatorUserPrompt(input, [])].join("\n");
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
  );
  try {
    const result = await Promise.race([model.generateContent(prompt), timeout]);
    const text = result.response.text();
    const parsed = extractJson(text);
    if (!parsed) return [];
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const mapped = candidates
      .map((c: any) => ({ reply: String(c?.reply || "").trim(), intent: String(c?.intent || "none") }))
      .filter((c: { reply: string; intent: string }) => c.reply.length > 0);
    if (mapped.length > 0) return mapped;
    if (typeof parsed?.reply === "string" && parsed.reply.trim().length > 0) {
      return [{ reply: parsed.reply.trim(), intent: "none" }];
    }
    return [];
  } catch {
    return [];
  }
}

async function callOpenAIAudit(
  client: OpenAI,
  model: string,
  input: AuditorInput,
  candidates: { reply: string; intent: string }[],
  timeoutMs: number
): Promise<{ approved: boolean; bestReply: string; bestIntent: string; edits: string[]; reasons: string[]; rejectFlags: string[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.responses.create(
      {
        model,
        input: [
          { role: "system", content: "Return JSON only." },
          { role: "user", content: auditorPrompt(input, candidates) }
        ],
        max_output_tokens: 220,
        temperature: 0.4
      },
      { signal: controller.signal }
    );
    const text = response.output_text?.trim() || "";
    const parsed = extractJson(text);
    if (!parsed) return null;
    return {
      approved: Boolean(parsed.approved),
      bestReply: typeof parsed.bestReply === "string" ? parsed.bestReply : "",
      bestIntent: typeof parsed.bestIntent === "string" ? parsed.bestIntent : "none",
      edits: Array.isArray(parsed.edits) ? parsed.edits : [],
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
      rejectFlags: Array.isArray(parsed.rejectFlags) ? parsed.rejectFlags : []
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiFinal(
  input: AuditorInput,
  draft: { reply: string; intent: string },
  timeoutMs: number
): Promise<{ reply: string; intent: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) return null;
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });
  const prompt = [
    "Polish the reply to be calm, firm, non-confrontational, 1-2 lines, <=160 chars.",
    "No banned phrases. No OTP/PIN/account ask. Keep same intent.",
    "Return JSON only: {\"reply\":\"...\",\"intent\":\"...\"}.",
    `reply: ${draft.reply}`,
    `intent: ${draft.intent}`,
    `scammerMessage: ${input.lastScammerMessage}`
  ].join("\n");
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Gemini final timeout")), timeoutMs)
  );
  try {
    const result = await Promise.race([model.generateContent(prompt), timeout]);
    const text = result.response.text();
    const parsed = extractJson(text);
    const reply = typeof parsed?.reply === "string" ? parsed.reply : "";
    const intent = typeof parsed?.intent === "string" ? parsed.intent : "none";
    if (!reply) return null;
    return { reply, intent };
  } catch {
    return null;
  }
}

function normalizeIntent(intent: string): string {
  const lower = intent.toLowerCase();
  if (SLOT_TO_INTENT[lower]) return SLOT_TO_INTENT[lower];
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
  const asked = input.askedSlots;
  const ladder: Array<{ key: string; question: string; skip?: boolean }> = [
    { key: "ask_ticket_or_case_id", question: "Do you have a ticket or case ID?" },
    { key: "ask_branch_city", question: "Which branch or city is this from?" },
    { key: "ask_department_name", question: "Which department is handling this?" },
    { key: "ask_employee_id", question: "What is your employee ID?" },
    { key: "ask_designation", question: "What is your designation?" },
    { key: "ask_callback_number", question: "What's the official callback or toll-free number?" },
    { key: "ask_escalation_authority", question: "Who is the escalation authority or manager here?" },
    { key: "ask_transaction_amount_time", question: "What transaction amount and time is this about?" },
    { key: "ask_transaction_mode", question: "Which mode was used - UPI, IMPS, or netbanking?" },
    { key: "ask_merchant_receiver", question: "Who is the merchant or receiver name?" },
    { key: "ask_device_type", question: "Which device type was used?" },
    { key: "ask_login_location", question: "Which city/location was this login from?" },
    { key: "ask_ip_or_reason", question: "Why was this login flagged as unusual?" },
    { key: "ask_otp_reason", question: "Why do you need OTP for this?" },
    { key: "ask_no_notification_reason", question: "Why didn't the app show any alert?" },
    { key: "ask_internal_system", question: "Which internal system flagged this?" },
    { key: "ask_phone_numbers", question: "Which official number are you calling from?" },
    { key: "ask_sender_id_or_email", question: "What's the official SMS sender ID or email domain?" },
    {
      key: "ask_links",
      question: "Why is a link needed for this?",
      skip: input.extractedIntel.phishingLinks.length > 0
    },
    { key: "ask_upi_or_beneficiary", question: "What's the UPI ID or beneficiary name?" },
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
  return null;
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
  if (timeLeft() > 400) {
    const timeout = Math.min(llmTimeoutMs, Math.max(400, timeLeft() - 100));
    candidates = await callGeminiGenerator(input, timeout);
  }

  const gptAudit =
    openai && timeLeft() > 400
      ? await callOpenAIAudit(openai, openaiModel, input, candidates, Math.min(llmTimeoutMs, timeLeft() - 100))
      : null;

  let revision: { reply: string; intent: string } | null = null;
  if (enableRevision && openai && gptAudit && timeLeft() > 600) {
    const draft = {
      reply: gptAudit.bestReply || "",
      intent: gptAudit.bestIntent || "none"
    };
    if (draft.reply) {
      revision = await callOpenAIRevision(
        openai,
        openaiModel,
        input,
        draft,
        gptAudit.reasons,
        Math.min(llmTimeoutMs, timeLeft() - 100)
      );
    }
  }

  const ordered: { reply: string; intent: string; source: string }[] = [];
  if (revision?.reply) ordered.push({ reply: revision.reply, intent: revision.intent, source: "gpt_revision" });
  if (gptAudit?.bestReply) ordered.push({ reply: gptAudit.bestReply, intent: gptAudit.bestIntent, source: "gpt_best" });
  candidates.forEach((c) => ordered.push({ reply: c.reply, intent: c.intent, source: "gemini_candidate" }));

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

  let finalSource = picked.source;
  const geminiFinal = timeLeft() > 300 ? await callGeminiFinal(input, { reply: finalReply, intent: finalIntent }, Math.min(llmTimeoutMs, timeLeft() - 50)) : null;
  if (geminiFinal?.reply) {
    finalReply = geminiFinal.reply;
    finalIntent = geminiFinal.intent || finalIntent;
    finalSource = "gemini_final";
  }

  safeLog(
    `[AUDITOR] ${input.sessionId} ${JSON.stringify({ used: finalSource, turn: input.turnIndex })}`
  );

  return { reply: finalReply, chosenIntent: finalIntent, notes: finalSource };
}
