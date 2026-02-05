import express, { Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { analyzeMessage, ExtractedIntel } from "./core/analyst";
import { chooseNextMove, NextMove } from "./core/strategist";
import { generateReply } from "./core/actor";
import { auditReply } from "./core/auditor";
import { sendFinalCallback } from "./utils/guvi";
import { normalizeReplyStyle } from "./core/style";

dotenv.config();

const app = express();
const turnResponse = (reply: string) => ({ status: "success", reply });

app.use(cors());
app.use(express.json({ type: "*/*", limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

type SessionRow = {
  session_id: string;
  history: unknown[];
  extracted_intel: ExtractedIntel;
  burnt_intents: string[];
  turn_count: number;
  scam_score: number;
};

async function getSession(sessionId: string): Promise<SessionRow | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();
  return data as SessionRow | null;
}

async function upsertSession(sessionId: string, patch: Partial<SessionRow>) {
  if (!supabase) return;
  await supabase.from("sessions").upsert({ session_id: sessionId, ...patch });
}

const emptyIntel: ExtractedIntel = {
  employee_codes: [],
  case_ids: [],
  phone_numbers: [],
  upi_ids: [],
  bank_accounts: [],
  links: [],
  emails: []
};

app.post("/api/honeypot", async (req: Request, res: Response) => {
  const body: any = req.body ?? {};
  const text =
    typeof body?.message?.text === "string"
      ? body.message.text
      : typeof body?.text === "string"
      ? body.text
      : "";

  if (!text || text.trim().length === 0) {
    return res.status(200).json(turnResponse("OK"));
  }

  const sessionId = body.sessionId || `sess-${Date.now()}`;
  const session = await getSession(sessionId);

  const prior: ExtractedIntel = session?.extracted_intel || emptyIntel;
  const burned = new Set<string>(session?.burnt_intents || []);

  const analyst = await analyzeMessage(text, prior, 1200);

  const move: NextMove = chooseNextMove({
    scammerText: text,
    extracted: analyst.extracted,
    burnt_intents: burned,
    repeatDemand: /(otp|pin|password)/.test(text.toLowerCase())
  });
  burned.add(move.goal);

  const draft = await generateReply(move, text, 1200);
  const audited = await auditReply(draft, text, 1200);

  const nextTurn = (session?.turn_count || 0) + 1;
  const history = Array.isArray(session?.history) ? session.history : [];
  const lastReplies = history
    .filter((h: any) => h?.sender === "honeypot" && typeof h?.text === "string")
    .map((h: any) => h.text)
    .slice(-5);
  const reply = normalizeReplyStyle(audited, {
    lastReplies,
    engagementStage: "CONFUSED",
    lastScammerMessage: text,
    turnIndex: nextTurn,
    maxTurns: 10
  });
  history.push({ sender: "scammer", text, ts: new Date().toISOString() });
  history.push({ sender: "honeypot", text: reply, ts: new Date().toISOString() });

  await upsertSession(sessionId, {
    history,
    extracted_intel: analyst.extracted,
    burnt_intents: Array.from(burned),
    turn_count: nextTurn,
    scam_score: analyst.scamScore
  });

  const intelCount = [
    analyst.extracted.phone_numbers.length > 0,
    analyst.extracted.links.length > 0,
    analyst.extracted.emails.length > 0,
    analyst.extracted.upi_ids.length > 0,
    analyst.extracted.case_ids.length > 0,
    analyst.extracted.employee_codes.length > 0
  ].filter(Boolean).length;

  if (nextTurn >= 10 || (analyst.scamScore >= 0.95 && intelCount >= 2)) {
    void sendFinalCallback({
      sessionId,
      totalMessagesExchanged: nextTurn,
      scamScore: analyst.scamScore,
      extracted: analyst.extracted
    });
  }

  return res.status(200).json(turnResponse(reply));
});

app.get("/health", (_req, res) => {
  return res.json({ ok: true });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.info(`HoneyPot API listening on port ${port}`);
});
