import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextMove } from "./strategist";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

const GOAL_HINTS: Record<string, string> = {
  GET_UPI: "Ask for the UPI handle or beneficiary name.",
  GET_EMPLOYEE_ID: "Ask for the caller's employee ID or officer code.",
  GET_LINK: "Ask for the official verification link/domain.",
  GET_CASE_ID: "Ask for the case/ticket/reference ID."
};

export async function generateReply(
  move: NextMove,
  scammerText: string,
  timeoutMs: number
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const fallback = `Sharing my PIN is risky. Please share the reference number so I can verify?`;

  if (!apiKey) return fallback;

  const prompt = [
    "You are a Skeptical Professional. Educated, cautious, slightly annoyed.",
    "You want to resolve this but will not share OTP/PIN.",
    "Use logic: verify to comply.",
    "Reply must be <200 chars and include a question.",
    "Avoid robotic language; be concise.",
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
      if (parsed?.reply) return String(parsed.reply);
    }
  } catch {
    // fallback
  }

  return fallback;
}
