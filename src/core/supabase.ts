import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type LogMessageInput = {
  sessionId: string;
  turnIndex: number;
  sender: "scammer" | "honeypot";
  text: string;
  timestamp: string;
  channel?: string;
  scenario?: string;
};

export type LogDecisionInput = {
  sessionId: string;
  turnIndex: number;
  stage: string;
  chosenIntent: string;
  reply: string;
};

export type SimilarExample = {
  scammer: string;
  honeypot: string;
};

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

const logEnabled = process.env.ENABLE_SUPABASE_LOG !== "false";
const retrievalEnabled = process.env.ENABLE_SUPABASE_RETRIEVAL === "true";

export async function logMessage(input: LogMessageInput): Promise<void> {
  if (!logEnabled) return;
  const sb = getClient();
  if (!sb) return;
  try {
    await sb.from("honeypot_messages").insert({
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      sender: input.sender,
      text: input.text,
      ts: input.timestamp,
      scenario: input.scenario || "",
      channel: input.channel || ""
    });
  } catch {
    // swallow
  }
}

export async function logDecision(input: LogDecisionInput): Promise<void> {
  if (!logEnabled) return;
  const sb = getClient();
  if (!sb) return;
  try {
    await sb.from("honeypot_decisions").insert({
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      persona_stage: input.stage,
      chosen_intent: input.chosenIntent,
      reply: input.reply
    });
  } catch {
    // swallow
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4);
}

export async function fetchSimilarExamples(params: {
  scenario?: string;
  scammerText: string;
  limit?: number;
}): Promise<SimilarExample[]> {
  if (!retrievalEnabled) return [];
  const sb = getClient();
  if (!sb) return [];
  const limit = params.limit ?? 3;
  const keywords = extractKeywords(params.scammerText);
  if (keywords.length === 0) return [];
  const pattern = `%${keywords[0]}%`;
  try {
    const base = sb
      .from("honeypot_messages")
      .select("session_id, turn_index, text, sender")
      .eq("sender", "scammer")
      .ilike("text", pattern)
      .limit(limit);
    const query = params.scenario ? base.eq("scenario", params.scenario) : base;
    const { data, error } = await query;
    if (error || !data) return [];
    const examples: SimilarExample[] = [];
    for (const row of data) {
      const { data: hp } = await sb
        .from("honeypot_messages")
        .select("text")
        .eq("session_id", row.session_id)
        .eq("turn_index", row.turn_index)
        .eq("sender", "honeypot")
        .limit(1)
        .maybeSingle();
      if (hp?.text) {
        examples.push({ scammer: row.text, honeypot: hp.text });
      }
      if (examples.length >= limit) break;
    }
    return examples;
  } catch {
    return [];
  }
}
