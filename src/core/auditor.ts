import OpenAI from "openai";

const DEFAULT_MODEL = "gpt-4o";

function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function auditReply(
  reply: string,
  scammerText: string,
  timeoutMs: number
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply;
  const client = new OpenAI({ apiKey, timeout: timeoutMs });

  const prompt = [
    "You are the Auditor. Enforce reluctant compliance and one-question rule.",
    "Reject if contains banned words: request denied, investigation, verifiable, legitimate channels, suspicious, authenticity, validation, furnish, kindly provide for verification.",
    "Reject if accuses scam or fraud, or if 2+ questions appear.",
    "Reject if dead-end stall (driving/meeting/network/busy/later).",
    "Rewrite to: polite, worried, slightly annoyed. Yes-but compliance.",
    "Keep SAME extraction goal as reply implies.",
    "Exactly ONE question mark. <=170 chars.",
    "Return JSON only: {\"approved\":true/false,\"reply\":\"...\"}",
    `Scammer: ${scammerText}`,
    `Reply: ${reply}`
  ].join("\n");

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      input: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: prompt }
      ],
      max_output_tokens: 120,
      temperature: 0.2
    });
    const text = response.output_text?.trim() || "";
    const parsed = extractJson(text);
    if (parsed && typeof parsed.reply === "string") {
      return parsed.reply;
    }
  } catch {
    // fallback
  }

  return reply;
}
