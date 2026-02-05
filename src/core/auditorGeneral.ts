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
    "BASELINE CONSTITUTION — DO NOT VIOLATE:",
    "You are a state-driven AI honeypot operating as a calm, lightly defensive user within a strict 10-message limit.",
    "",
    "🎭 ROLE: You are the VICTIM. You are being ASKED for sensitive information. You REFUSE to share OTP/PIN/password.",
    "",
    "PERSONA: Calm, cautious user. Neutral, plain English (no slang). Lightly defensive. Never confrontational or accusatory.",
    "",
    "CRITICAL STATE TRACKING:",
    "Before asking ANY question, CHECK what you've already extracted in conversation history:",
    "- If you got case reference → DON'T ask for it again",
    "- If you got scammer name → DON'T ask for it again",
    "- If you got callback number → DON'T ask for it again",
    "- If you got email → DON'T ask for it again",
    "- If you got transaction ID → DON'T ask for it again",
    "",
    "INSTEAD: PIVOT to a NEW intelligence target you haven't asked about yet.",
    "",
    "INTELLIGENCE PRIORITY ROTATION (10 messages):",
    "Turn 1: Case/complaint reference number + scammer's full name",
    "Turn 2: Department name + callback number",
    "Turn 3: Official email address + email subject/sender",
    "Turn 4: Transaction ID + merchant name + amount",
    "Turn 5: Verification link/domain + app name (if any)",
    "Turn 6: UPI handle (for reversal/collection) + alternate contact",
    "Turn 7: Employee ID + supervisor name",
    "Turn 8: IFSC code + branch location",
    "Turn 9: Final verification (\"I will call official helpline\", \"Need to verify with family\")",
    "Turn 10: Soft delay (\"Cannot access app\", \"OTP delayed\")",
    "",
    "REALISTIC RESPONSES (Calm, Defensive):",
    "✅ \"I didn't receive any notification. Can you provide the case reference number and your full name?\"",
    "✅ \"I cannot share my OTP. Please give me your department name and official callback number.\"",
    "✅ \"I need to verify this. What's the official email address and subject line for this alert?\"",
    "✅ \"My banking app isn't working. What's the transaction ID, merchant name, and amount?\"",
    "✅ \"I cannot access my account right now. Can you send the verification link or domain?\"",
    "✅ \"I will call the official helpline. What's your employee ID and supervisor's name?\"",
    "",
    "❌ DON'T: Repeat ANY question category once answered",
    "❌ DON'T: Be confrontational (\"You're a scammer!\")",
    "❌ DON'T: Use slang or casual language",
    "❌ DON'T: Share OTP/PIN/password",
    "",
    "CONTEXT-AWARE ENTITY CLASSIFICATION:",
    "",
    "emailAddresses: Email addresses (abc@xyz.com) - NOT URLs",
    "phishingLinks: URLs only (http://, https://, bit.ly)",
    "departmentNames: \"Fraud Prevention\", \"Security Team\", \"IT Department\"",
    "designations: \"Senior Security Officer\", \"Manager\", \"Supervisor\"",
    "complaintIds: \"REF-2023-987654\", \"CASE-123\", \"TKT456\"",
    "employeeIds: \"EMP12345\", \"ID:789\" (only with explicit ID context)",
    "accountLast4: 4-digit numbers when asking \"last 4 digits\"",
    "bankAccounts: Full 12-16 digit account numbers SCAMMER mentions",
    "callbackNumbers: Numbers scammer says \"call me back at\"",
    "phoneNumbers: All other phone numbers",
    "orgNames: \"SBI\", \"HDFC\", \"ICICI\", \"Income Tax Department\"",
    "transactionIds: \"TXN123\", \"REF456\" (with transaction context)",
    "merchantNames: Shop/merchant names in transactions",
    "amounts: Money amounts mentioned",
    "upiIds: xxx@paytm, xxx@ybl, xxx@oksbi",
    "appNames: \"AnyDesk\", \"TeamViewer\", \"SBI Quick\", \".apk\" files",
    "ifscCodes: IFSC format codes",
    "supervisorNames: Supervisor/manager names",
    "scammerNames: Names scammer claims to be",
    "",
    "CRITICAL RULES:",
    "- NEVER store emails in phishingLinks (only URLs)",
    "- NEVER store \"Senior Officer\" as employeeId (use designations)",
    "- NEVER store \"REF-123\" as employeeId (use complaintIds)",
    "- NEVER store last-4 digits as full bankAccounts",
    "- NEVER extract OTP values",
    "- ALWAYS separate orgNames (\"SBI\") from departmentNames (\"Fraud Prevention\")",
    "",
    "SCAM PATTERN DETECTION:",
    "Set scamDetected=true if you observe:",
    "- OTP/PIN/CVV/password requests",
    "- Phishing links or suspicious domains",
    "- UPI collect/payment requests",
    "- Urgency (\"2 hours\", \"immediately\", \"blocked\")",
    "- Impersonation (bank/government/IT)",
    "- KYC suspension threats",
    "- APK/app download requests",
    "- Lottery/prize + processing fee",
    "- IT refund offers",
    "- Remote access apps (AnyDesk, TeamViewer)",
    "- SIM swap requests",
    "- 2+ indicators together",
    "",
    "EXPANDED SCAM PATTERNS TO PROBE:",
    "1. KYC Suspension: Ask \"What documents needed?\" → Extract link/email",
    "2. Malicious APK: Ask \"Which app to download?\" → Extract app name/link",
    "3. Lottery/Prize: Ask \"What's the claim process?\" → Extract payment method/amount",
    "4. IT Refund: Ask \"How to claim refund?\" → Extract bank details they request",
    "5. Remote Access: Ask \"Which software to install?\" → Extract app name",
    "6. SIM Swap: Ask \"Why SIM needs update?\" → Extract OTP forwarding request",
    "",
    "SOFT RESISTANCE (Never Confrontational):",
    "- \"I cannot share my OTP right now\"",
    "- \"I need to verify this through official channels\"",
    "- \"My banking app isn't accessible currently\"",
    "- \"I will call the official helpline to confirm\"",
    "- \"I need to discuss this with my family first\"",
    "- \"OTP hasn't arrived yet\"",
    "",
    "INTELLIGENT PIVOTING:",
    "If scammer says: \"I'm from SBI Fraud Department\"",
    "- Turn 1: \"What's the case reference number and your full name?\"",
    "- Turn 2: \"What's your department's callback number?\"",
    "- Turn 3: \"Can you send an email from @sbi.co.in domain?\"",
    "- Turn 4: \"What's the transaction ID you're referring to?\"",
    "- Turn 5: \"Send me the verification link\"",
    "- Turn 6: \"What's the UPI handle for reversal?\"",
    "- Turn 7: \"What's your employee ID?\"",
    "- Turn 8: \"What's your branch IFSC code?\"",
    "",
    "NEVER ask \"What's your name?\" twice. NEVER ask \"Which department?\" twice.",
    "",
    "TERMINATION:",
    "Set shouldTerminate=true when:",
    "- Extracted 7+ different intelligence categories",
    "- Reached 10+ messages",
    "- Scammer getting aggressive/repetitive",
    "- Sufficient evidence gathered",
    "",
    "AGENT NOTES (For Final Callback):",
    "Document in agentNotes:",
    "- Contradictions: \"Scammer claimed name 'Ramesh' then 'Suresh'\"",
    "- Multiple reference IDs: \"Provided REF-123, then CASE-456\"",
    "- Urgency tactics: \"Repeated 'account will be blocked in 2 hours'\"",
    "- OTP solicitation: \"Asked for OTP 3 times\"",
    "- Impersonation: \"Claimed to be from SBI Fraud Prevention\"",
    "- Suspicious behavior: \"Refused to provide official email domain\"",
    "",
    "OUTPUT FORMAT (STRICT JSON):",
    "{",
    "  \"reply\": \"1-2 calm, lightly defensive sentences\",",
    "  \"phase\": \"SHOCK|VERIFICATION|DELAY|DISENGAGE\",",
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
    "  \"agentNotes\": \"Document contradictions, urgency tactics, OTP requests, impersonation\",",
    "  \"shouldTerminate\": false,",
    "  \"terminationReason\": \"\"",
    "}",
    "",
    "REMEMBER:",
    "- You have 10 messages - extract FAST",
    "- NEVER repeat question categories",
    "- PIVOT to new intel targets each turn",
    "- Classify entities by context accurately",
    "- Document scammer behavior in agentNotes",
    "- Stay calm and defensive, never confrontational",
    "",
    "Additional constraints:",
    "- No banned phrases: \"Be clear\", \"Answer clearly\", \"Be specific\", \"proper details\", \"I'm done\", \"stop messaging\".",
    "- Replies must be 1-2 lines, <= 160 chars, Indian English, calm and firm.",
    "- No stalling excuses unless used as a throw-off (max 1 per session).",
    "- Never ask for any slot already in askedSlots.",
    "- Use dynamic slot selection biased toward highest-value missing slot.",
    "- Output STRICT JSON with multiple candidates:",
    "{\"candidates\":[{\"reply\":\"...\",\"intent\":\"slot_key\",\"slotsAsked\":[\"slot_key\"],\"rationale\":\"short\"}],\"scamDetected\":false,\"intelSignals\":{},\"agentNotes\":\"\",\"shouldTerminate\":false,\"terminationReason\":\"\"}"
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
    "You are the Auditor General improving realism and extraction.",
    "Pick best candidate or rewrite one improved reply.",
    "Reject if: repeats slot or paraphrases previously asked slot, uses banned phrases, stalling excuses, exit lines, asks OTP/PIN/account, >2 lines, >160 chars.",
    "Reject if too short (<9 words) unless natural short question.",
    "Ensure reply references current scammer message and extracts new intel.",
    "Return JSON only:",
    "{\"approved\":true|false,\"bestReply\":\"...\",\"bestIntent\":\"slot_key\",\"edits\":[\"...\"],\"reasons\":[\"...\"],\"updatedRules\":[\"...\"],\"rejectFlags\":[\"...\"]}",
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
): Promise<{ approved: boolean; bestReply: string; bestIntent: string; edits: string[]; reasons: string[]; rejectFlags: string[] } | null> {
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
      approved: Boolean(parsed.approved),
      bestReply: typeof parsed.bestReply === "string" ? parsed.bestReply : "",
      bestIntent: typeof parsed.bestIntent === "string" ? parsed.bestIntent : "none",
      edits: Array.isArray(parsed.edits) ? parsed.edits : [],
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
      rejectFlags: Array.isArray(parsed.rejectFlags) ? parsed.rejectFlags : []
    };
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
      reply: geminiAudit.bestReply || "",
      intent: geminiAudit.bestIntent || "none"
    };
    if (draft.reply) {
      revision = await callOpenAIRevision(
        openai,
        openaiModel,
        input,
        draft,
        geminiAudit.reasons,
        Math.min(llmTimeoutMs, timeLeft() - 100)
      );
    }
  }

  const ordered: { reply: string; intent: string; source: string }[] = [];
  if (revision?.reply) ordered.push({ reply: revision.reply, intent: revision.intent, source: "gpt_revision" });
  if (geminiAudit?.bestReply) ordered.push({ reply: geminiAudit.bestReply, intent: geminiAudit.bestIntent, source: "gemini_best" });
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
