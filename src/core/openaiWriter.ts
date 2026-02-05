import OpenAI from "openai";
import { WriterInput } from "./writer";
import { Persona } from "./persona";

const DEFAULT_MODEL = "gpt-4o-mini";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return (await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OpenAI timeout")), timeoutMs)
    )
  ])) as T;
}

function buildSystemPrompt(): string {
  return [
    "You are a stressed Indian user replying to a suspicious bank/security message.",
    "Follow the given nextSlot exactly. Only phrase the reply; do not choose strategy.",
    "Reply in 1-2 short lines. Natural Indian texting, slightly imperfect but not cringe.",
    "Over-polished language is undesirable; emotional drift over turns is expected.",
    "Never mention scam, fraud, honeypot, AI, or detection.",
    "Never ask for OTP/PIN/account number.",
    "Avoid exit phrases (I'm done/stop messaging/calling bank).",
    "If stressScore is high, include one emotional cue like 'I'm worried'.",
    "Make the reply a smart extraction question tied to nextSlot.",
    "Output ONLY the reply text. No quotes, no JSON, no explanations."
  ].join(" ");
}

function buildUserPrompt(input: WriterInput, persona: Persona, summary: string): string {
  return [
    `nextSlot: ${input.nextSlot}`,
    `turnNumber: ${input.turnNumber}`,
    `stressScore: ${input.stressScore.toFixed(2)}`,
    `state: anxiety=${input.state.anxiety.toFixed(2)}, confusion=${input.state.confusion.toFixed(2)}, overwhelm=${input.state.overwhelm.toFixed(2)}, trust=${input.state.trustAuthority.toFixed(2)}, compliance=${input.state.compliance.toFixed(2)}`,
    `persona: tone=${persona.tone}, context=${persona.context}, languageStyle=${persona.languageStyle}, techLevel=${persona.techLevel}, signatureWords=${persona.signatureWords.join(",")}`,
    `story: claim=${input.story.scammerClaim || "unknown"}, ask=${input.story.scammerAsk || "unknown"}`,
    `lastScammerMessage: ${input.lastScammerMessage}`,
    `conversationSummary: ${summary}`
  ].join("\n");
}

export async function generateReplyOpenAI(
  input: WriterInput,
  persona: Persona,
  conversationSummary: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 2800);

  const client = new OpenAI({ apiKey, timeout: timeoutMs });

  const responsePromise = client.responses.create({
    model,
    input: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input, persona, conversationSummary) }
    ],
    max_output_tokens: 80,
    temperature: 0.7
  });

  const response = await withTimeout(responsePromise, timeoutMs);

  return response.output_text?.trim() || "";
}
