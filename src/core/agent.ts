import { GoogleGenerativeAI } from "@google/generative-ai";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

const OBSTACLES: Record<string, string[]> = {
  ask_ticket_or_case_id: [
    "the app asks for a Case Reference ID to proceed",
    "it says enter Case ID, but I don't see it"
  ],
  ask_employee_id: [
    "it wants Officer Code before it unlocks",
    "the screen says Caller Employee Code is required"
  ],
  ask_upi_or_beneficiary: [
    "it says enter Beneficiary/UPI handle to continue",
    "it asks for UPI ID for verification"
  ],
  ask_branch_city: [
    "it asks for branch/city to verify",
    "it shows a dropdown for branch location"
  ],
  ask_callback_number: [
    "it asks for official callback number",
    "it wants the number you are calling from"
  ],
  ask_sender_id_or_email: [
    "it asks for official email or SMS sender ID",
    "it says verify sender ID before proceeding"
  ],
  ask_phone_numbers: [
    "it asks for the phone number of the officer",
    "it wants the contact number on record"
  ],
  ask_keywords_used: [
    "it asks what alert keyword triggered this",
    "it wants the exact alert reason"
  ]
};

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

export async function generateAgentReply(
  goal: string,
  lastScammerMessage: string,
  panicPrefix: string,
  timeoutMs: number
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const obstacle = pick(OBSTACLES[goal] || OBSTACLES.ask_keywords_used);
  const defaultReply = [
    panicPrefix ? `${panicPrefix},` : "Please",
    "I am trying to do it but",
    `${obstacle}.`,
    "What should I enter?"
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!apiKey) return defaultReply;

  const prompt = [
    "You are an elderly Indian user. You are scared and want to comply.",
    "Use Reaction + Obstacle + Ask.",
    "Reaction: acknowledge threat (panic, urgency).",
    "Obstacle: technical error/blocked screen.",
    "Ask: request the info needed to fix it.",
    "Do NOT use templates like 'I am trying, but...' exactly.",
    "Keep 1-2 lines, <=200 chars, include a question mark.",
    `Goal: ${goal}`,
    `Panic prefix: ${panicPrefix}`,
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
    // fallback
  }

  return defaultReply;
}
