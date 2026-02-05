import OpenAI from "openai";
import type { CouncilInput } from "../council";

type OpenAICandidates = {
  candidates: string[];
  tags: string[];
  model: string;
};

const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const FALLBACK_OPENAI_MODEL = "gpt-5 mini";

function buildSystemPrompt(): string {
  return [
    "You are a stressed Indian user replying to a suspicious bank/security message.",
    "Reply in 1-2 short lines. Indian English, anxious but not stupid.",
    "Never accuse directly. Never mention scam, fraud, honeypot, AI.",
    "Never give OTP/PIN/UPI or ask for OTP/PIN.",
    "Do NOT ask for link/UPI unless scammer already mentioned link/UPI/phone.",
    "Add mild suspicion or friction and 1 short question if possible.",
    "Output STRICT JSON only: {\"candidates\":[\"...\",\"...\"],\"tags\":[\"...\",\"...\"]}"
  ].join(" ");
}

function buildUserPrompt(input: CouncilInput): string {
  const lastReplies = input.lastReplies.slice(-3).join(" | ") || "none";
  const intelSummary = [
    `upiIds=${input.extractedIntel.upiIds.length}`,
    `links=${input.extractedIntel.phishingLinks.length}`,
    `phones=${input.extractedIntel.phoneNumbers.length}`
  ].join(", ");
  return [
    `lastScammerMessage: ${input.lastScammerMessage}`,
    `turnCount: ${input.turnCount}`,
    `stressScore: ${input.stressScore.toFixed(2)}`,
    `scamScore: ${input.scamScore.toFixed(2)}`,
    `lastReplies: ${lastReplies}`,
    `extracted: ${intelSummary}`,
    `story: ${input.storySummary}`
  ].join("\n");
}

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

async function callModel(
  client: OpenAI,
  model: string,
  input: CouncilInput,
  timeoutMs: number
): Promise<OpenAICandidates> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.responses.create(
      {
        model,
        input: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(input) }
        ],
        max_output_tokens: 160,
        temperature: 0.6
      },
      { signal: controller.signal }
    );
    const text = response.output_text?.trim() || "";
    const parsed = extractJson(text);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
    return {
      candidates: candidates.filter((c: unknown) => typeof c === "string"),
      tags: tags.filter((t: unknown) => typeof t === "string"),
      model
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateOpenAICandidates(
  input: CouncilInput,
  timeoutMs: number
): Promise<OpenAICandidates> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const primary = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const fallback = process.env.OPENAI_FALLBACK_MODEL || FALLBACK_OPENAI_MODEL;
  const models = [primary, fallback].filter((m, idx, arr) => arr.indexOf(m) === idx);
  const client = new OpenAI({ apiKey, timeout: timeoutMs });
  let lastErr: unknown = null;
  for (const model of models) {
    try {
      return await callModel(client, model, input, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("OpenAI failed");
}
