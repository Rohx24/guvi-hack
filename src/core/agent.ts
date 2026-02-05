import { GoogleGenerativeAI } from "@google/generative-ai";
import { Context } from "./memory";
import { PlannerResult } from "./planner";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

function buildSystemPrompt(): string {
  return [
    "You are an educated, professional Indian user. You are SKEPTICAL and THOROUGH.",
    "Rule 1: Acknowledge the scammer's name if known (e.g., 'Okay, Rajesh').",
    "Rule 2: Acknowledge any data they gave (e.g., 'Thanks for the ID 9876').",
    "Rule 3: NEVER use the phrase 'I am trying, but...'. It is banned.",
    "Rule 4: Use soft blockers: 'I've noted that, but I need to check with my manager.'",
    "Tone: Polite, stubborn, professional. Ask a question every reply.",
    "Keep under 200 chars, 1-2 lines."
  ].join(" ");
}

function buildUserPrompt(context: Context, plan: PlannerResult, lastMessage: string): string {
  return [
    `Name: ${context.scammerName || "unknown"}`,
    `Branch: ${context.claimedBranch || "unknown"}`,
    `Dept: ${context.claimedDept || "unknown"}`,
    `Phone: ${context.extracted.phone || "none"}`,
    `UPI: ${context.extracted.upi || "none"}`,
    `ID: ${context.extracted.id || "none"}`,
    `HistorySummary: ${context.historySummary}`,
    `Tone: ${plan.tone}`,
    `Intent: ${plan.intent}`,
    `Reason: ${plan.reason}`,
    `ScammerMessage: ${lastMessage}`,
    "Reply in natural Indian English. Weave the intent into a professional question."
  ].join("\n");
}

export async function generateReply(
  context: Context,
  plan: PlannerResult,
  lastMessage: string,
  timeoutMs = 1200
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    const name = context.scammerName ? `Okay, ${context.scammerName}. ` : "";
    return `${name}I've noted that. Can you confirm the case reference number?`;
  }

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  });

  const prompt = [
    buildSystemPrompt(),
    "",
    buildUserPrompt(context, plan, lastMessage),
    "",
    "Return JSON only: {\"reply\":\"...\"}"
  ].join("\n");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
  );

  try {
    const result = await Promise.race([model.generateContent(prompt), timeout]);
    const text = result.response.text();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed?.reply) return String(parsed.reply);
    }
  } catch {
    // fallback
  }

  const name = context.scammerName ? `Okay, ${context.scammerName}. ` : "";
  return `${name}I've noted that, but I need a reference number. What is it?`;
}
