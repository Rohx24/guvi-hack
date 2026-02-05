import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CouncilInput } from "../council";

type GeminiResult = {
  improved: string;
  pick: number;
  reasons: string[];
  model: string;
};

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const FALLBACK_GEMINI_MODEL = "gemini-1.5-flash";

function buildPrompt(input: CouncilInput, candidates: string[]): string {
  const list = candidates.length > 0 ? candidates.map((c, i) => `${i}: ${c}`).join("\n") : "none";
  return [
    "You are a critique agent improving scammer-reply realism.",
    "Review the candidates (if any) and propose ONE improved reply.",
    "Reply must be 1-2 short lines, Indian English, anxious + suspicious, not accusatory.",
    "Never mention scam/fraud/AI. Never ask for OTP/PIN or link unless scammer already sent one.",
    "Return JSON only: {\"pick\":0|1,\"improved\":\"...\",\"reasons\":[\"...\"]}",
    `lastScammerMessage: ${input.lastScammerMessage}`,
    `turnCount: ${input.turnCount}`,
    `candidates:\n${list}`
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
  client: GoogleGenerativeAI,
  modelName: string,
  input: CouncilInput,
  candidates: string[]
): Promise<GeminiResult> {
  const model = client.getGenerativeModel({ model: modelName });
  const prompt = buildPrompt(input, candidates);
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = extractJson(text);
  const improved = typeof parsed?.improved === "string" ? parsed.improved : "";
  const pick = typeof parsed?.pick === "number" ? parsed.pick : -1;
  const reasons = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
  return { improved, pick, reasons, model: modelName };
}

export async function generateGeminiImproved(
  input: CouncilInput,
  candidates: string[],
  timeoutMs: number
): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }
  const primary = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const fallback = process.env.GEMINI_FALLBACK_MODEL || FALLBACK_GEMINI_MODEL;
  const models = [primary, fallback].filter((m, idx, arr) => arr.indexOf(m) === idx);
  const client = new GoogleGenerativeAI(apiKey);
  let lastErr: unknown = null;
  for (const model of models) {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
      );
      return await Promise.race([callModel(client, model, input, candidates), timeout]);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Gemini failed");
}
