import { GoogleGenerativeAI } from "@google/generative-ai";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

const GOAL_PROMPTS: Record<string, string> = {
  ask_ticket_or_case_id:
    "I am trying, but it says 'Enter Case Reference ID' to continue. What should I type there?",
  ask_employee_id:
    "I am trying, but the app asks for 'Caller Employee Code' to unlock. What is it quickly?",
  ask_upi_or_beneficiary:
    "I am trying to transfer, but it says 'Enter Beneficiary/UPI Handle'. What is it?",
  ask_branch_city:
    "I am trying, but it asks for branch/city. Which branch is this under?",
  ask_callback_number:
    "I am trying, but it asks for official callback number. What should I enter?",
  ask_sender_id_or_email:
    "I am trying, but it asks for official email/SMS sender ID. What is it?",
  ask_phone_numbers:
    "I am trying, but it asks for the phone number you are calling from. What is it?",
  ask_keywords_used:
    "I am trying, but it asks what keyword/alert triggered this. What should I write?"
};

export async function generateReply(
  goal: string,
  lastScammerMessage: string,
  timeoutMs: number
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const fallback = GOAL_PROMPTS[goal] || GOAL_PROMPTS.ask_keywords_used;

  if (!apiKey) return fallback;

  const prompt = [
    "You are a panic-stricken, low-tech Indian victim.",
    "You are trying to comply but blocked by a technical error.",
    "Always say: 'I am trying, but...'.",
    "Ask urgently for the needed info to fix the error.",
    "Reply in 1-2 lines, <=200 chars, include a question mark.",
    `GOAL: ${goal}`,
    `Scammer message: ${lastScammerMessage}`,
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
    // fall back
  }

  return fallback;
}
