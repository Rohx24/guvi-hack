import { GoogleGenerativeAI } from "@google/generative-ai";

export type ExtractedIntel = {
  employee_codes: string[];
  case_ids: string[];
  phone_numbers: string[];
  upi_ids: string[];
  bank_accounts: string[];
  links: string[];
  emails: string[];
};

export type AnalystResult = {
  extracted: ExtractedIntel;
  scamScore: number;
  triggers: string[];
};

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

const EMPTY_INTEL: ExtractedIntel = {
  employee_codes: [],
  case_ids: [],
  phone_numbers: [],
  upi_ids: [],
  bank_accounts: [],
  links: [],
  emails: []
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

export async function analyzeMessage(
  message: string,
  prior: ExtractedIntel,
  timeoutMs: number
): Promise<AnalystResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  let extracted = { ...EMPTY_INTEL };

  if (apiKey) {
    try {
      const client = new GoogleGenerativeAI(apiKey);
      const model = client.getGenerativeModel({ model: modelName });
      const prompt = [
        "Extract the following entities to JSON:",
        "employee_codes, case_ids, phone_numbers, upi_ids, bank_accounts, links, emails.",
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
          bank_accounts: normalizeArray(parsed.bank_accounts),
          links: normalizeArray(parsed.links),
          emails: normalizeArray(parsed.emails)
        };
      }
    } catch {
      extracted = { ...EMPTY_INTEL };
    }
  }

  const merge = (a: string[], b: string[]) =>
    Array.from(new Set([...a, ...b].map((v) => v.trim()).filter(Boolean)));

  const merged: ExtractedIntel = {
    employee_codes: merge(prior.employee_codes, extracted.employee_codes),
    case_ids: merge(prior.case_ids, extracted.case_ids),
    phone_numbers: merge(prior.phone_numbers, extracted.phone_numbers),
    upi_ids: merge(prior.upi_ids, extracted.upi_ids),
    bank_accounts: merge(prior.bank_accounts, extracted.bank_accounts),
    links: merge(prior.links, extracted.links),
    emails: merge(prior.emails, extracted.emails)
  };

  const t = message.toLowerCase();
  const triggers: string[] = [];
  let scamScore = 0.4;

  if (/(otp|upi pin|pin|password)/.test(t)) {
    scamScore = 0.98;
    triggers.push("otp_or_pin");
  } else if (/(link|http|https|bit\.ly)/.test(t) && /(blocked|urgent|immediately|asap)/.test(t)) {
    scamScore = 0.95;
    triggers.push("link_urgency");
  } else if (/(account number|bank account|ifsc|card number)/.test(t) && /(urgent|blocked|immediately|asap)/.test(t)) {
    scamScore = 0.9;
    triggers.push("account_urgency");
  }

  return { extracted: merged, scamScore, triggers };
}
