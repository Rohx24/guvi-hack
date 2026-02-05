import { GoogleGenerativeAI } from "@google/generative-ai";
import { LlmExtraction, AnalystOutput } from "../utils/types";

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

const EMPTY_EXTRACTION: LlmExtraction = {
  employee_codes: [],
  case_ids: [],
  phone_numbers: [],
  upi_ids: [],
  bank_account_digits: []
};

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

function normalizeArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v).trim()).filter(Boolean);
}

function mergeExtraction(base: LlmExtraction, next: LlmExtraction): LlmExtraction {
  const merge = (a: string[], b: string[]) =>
    Array.from(new Set([...a, ...b].map((v) => v.trim()).filter(Boolean)));
  return {
    employee_codes: merge(base.employee_codes, next.employee_codes),
    case_ids: merge(base.case_ids, next.case_ids),
    phone_numbers: merge(base.phone_numbers, next.phone_numbers),
    upi_ids: merge(base.upi_ids, next.upi_ids),
    bank_account_digits: merge(base.bank_account_digits, next.bank_account_digits)
  };
}

function triggerScamScore(text: string): { score: number; triggers: string[] } {
  const t = text.toLowerCase();
  const triggers: string[] = [];
  const hasOtp = /(otp|pin|cvv|password)/.test(t);
  const hasUrgency = /(urgent|immediately|within|blocked|suspended|asap|today)/.test(t);
  const hasFinancial = /(pay|transfer|send money|collect|upi|payment|refund)/.test(t);
  const hasThreat = /(blocked|suspended|legal|fine|penalty|complaint|arrest)/.test(t);
  const hasLink = /(http:\/\/|https:\/\/|bit\.ly|tinyurl|link)/.test(t);

  if (hasOtp) {
    triggers.push("otp_request");
    return { score: 0.95, triggers };
  }
  if (hasUrgency && hasFinancial) {
    triggers.push("urgency_financial");
    return { score: 0.9, triggers };
  }
  if (hasThreat && hasLink) {
    triggers.push("threat_link");
    return { score: 0.85, triggers };
  }
  if (hasFinancial || hasLink || hasUrgency || hasThreat) {
    triggers.push("suspicious");
    return { score: 0.75, triggers };
  }
  return { score: 0.4, triggers };
}

export async function analyzeMessage(
  message: string,
  prior: LlmExtraction,
  timeoutMs: number
): Promise<AnalystOutput> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  let extracted = { ...EMPTY_EXTRACTION };

  if (apiKey) {
    try {
      const client = new GoogleGenerativeAI(apiKey);
      const model = client.getGenerativeModel({ model: modelName });
      const prompt = [
        "Extract the following entities to JSON:",
        "employee_codes, case_ids, phone_numbers, upi_ids, bank_account_digits.",
        "If a number is explicitly labeled 'Employee Code', extract it even if it's just '4567'.",
        "Return JSON only.",
        `message: ${message}`
      ].join("\n");
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
      );
      const result = await Promise.race([model.generateContent(prompt), timeout]);
      const parsed = extractJson(result.response.text());
      if (parsed) {
        extracted = {
          employee_codes: normalizeArray(parsed.employee_codes),
          case_ids: normalizeArray(parsed.case_ids),
          phone_numbers: normalizeArray(parsed.phone_numbers),
          upi_ids: normalizeArray(parsed.upi_ids),
          bank_account_digits: normalizeArray(parsed.bank_account_digits)
        };
      }
    } catch {
      extracted = { ...EMPTY_EXTRACTION };
    }
  }

  const merged = mergeExtraction(prior, extracted);
  const scoring = triggerScamScore(message);

  return {
    extracted: merged,
    scamScore: scoring.score,
    triggers: scoring.triggers
  };
}
