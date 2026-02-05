import { GoogleGenerativeAI } from "@google/generative-ai";

export interface Context {
  scammerName?: string;
  claimedBranch?: string;
  claimedDept?: string;
  extracted: {
    phone: string | null;
    upi: string | null;
    id: string | null;
  };
  historySummary: string;
}

const DEFAULT_MODEL = "gemini-2.0-flash";

const EMPTY_CONTEXT: Context = {
  extracted: {
    phone: null,
    upi: null,
    id: null
  },
  historySummary: ""
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

export function normalizeContext(ctx?: Context): Context {
  if (!ctx) return { ...EMPTY_CONTEXT };
  return {
    scammerName: ctx.scammerName || undefined,
    claimedBranch: ctx.claimedBranch || undefined,
    claimedDept: ctx.claimedDept || undefined,
    extracted: {
      phone: ctx.extracted?.phone ?? null,
      upi: ctx.extracted?.upi ?? null,
      id: ctx.extracted?.id ?? null
    },
    historySummary: ctx.historySummary || ""
  };
}

export async function updateContext(
  lastMessage: string,
  prior?: Context,
  timeoutMs = 1200
): Promise<Context> {
  const ctx = normalizeContext(prior);
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey || !lastMessage) return ctx;

  const prompt = [
    "Extract into JSON: scammerName, claimedBranch, claimedDept, phone, upi, id.",
    "If not present, return null for that field.",
    "Return JSON only.",
    `message: ${lastMessage}`
  ].join("\n");

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL || DEFAULT_MODEL });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
    );
    const result = await Promise.race([model.generateContent(prompt), timeout]);
    const parsed = extractJson(result.response.text());
    if (parsed) {
      ctx.scammerName = parsed.scammerName || ctx.scammerName;
      ctx.claimedBranch = parsed.claimedBranch || ctx.claimedBranch;
      ctx.claimedDept = parsed.claimedDept || ctx.claimedDept;
      ctx.extracted.phone = parsed.phone || ctx.extracted.phone;
      ctx.extracted.upi = parsed.upi || ctx.extracted.upi;
      ctx.extracted.id = parsed.id || ctx.extracted.id;
    }
  } catch {
    // ignore extraction errors
  }

  return ctx;
}

export function updateHistorySummary(
  ctx: Context,
  lastTurns: string[]
): Context {
  const summary = lastTurns.slice(-3).join(" | ");
  return { ...ctx, historySummary: summary };
}
