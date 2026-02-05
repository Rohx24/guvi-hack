import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextMove } from "./strategist";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

const GOAL_HINTS: Record<string, string> = {
  GET_UPI: "Ask for the UPI handle or beneficiary/merchant name.",
  GET_EMPLOYEE_ID: "Ask for the employee ID or officer code.",
  GET_LINK: "Ask for the full verification URL.",
  GET_CASE_ID: "Ask for the case/ticket/reference ID.",
  GET_CALLBACK: "Ask for callback number or alternate number.",
  GET_EMAIL: "Ask for official email/sender address.",
  GET_BRANCH: "Ask for branch/city."
};

function enforceSingleQuestion(reply: string): string {
  const parts = reply.split("?");
  if (parts.length <= 2) return reply.trim();
  return parts[0].trim() + "?";
}

export async function generateReply(
  move: NextMove,
  scammerText: string,
  timeoutMs: number
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const fallback = `Okay, I will check. It asks for the reference ID to continue. What is it?`;

  if (!apiKey) return fallback;

  const prompt = [
    "You are a Skeptical, Reluctant Complier (Indian English).",
    "Tone: polite, worried, slightly annoyed. Not accusatory.",
    "Yes-but compliance: 'Ok I will do it, but it's asking for __'.",
    "Template: Acknowledge + Attempt/constraint + Blocker + Ask.",
    "Exactly ONE question mark. Max 170 chars. 1-2 sentences.",
    "Never say 'request denied' or legal/detective language.",
    "Never mention scam/fraud/suspicious/validation/legitimate channels.",
    "Never use dead-end stalls (driving/meeting/network/busy/later).",
    `Goal: ${move.goal}`,
    `Context: ${move.context}`,
    `Hint: ${GOAL_HINTS[move.goal] || ""}`,
    `Scammer: ${scammerText}`,
    "Return JSON only: {\"reply\":\"...\"}"
  ].join("\n");

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: modelName });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
    );
    const result = await Promise.race([model.generateContent(prompt), timeout]);
    const text = result.response.text();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed?.reply) return enforceSingleQuestion(String(parsed.reply));
    }
  } catch {
    // fallback
  }

  return enforceSingleQuestion(fallback);
}
