import { Router, Request, Response } from "express";
import { extractIntelligence, mergeIntelligence, normalizeText } from "../core/extractor";
import { computeScores } from "../core/scoring";
import { planNext } from "../core/planner";
import { writeReplySmart } from "../core/writer";
import { SessionStore } from "../core/sessionStore";
import { sendFinalCallback } from "../core/callback";
import { summarize } from "../core/summarizer";
import { generateReplyOpenAI } from "../core/openaiWriter";
import { makeFullSchema } from "../utils/guviSchema";
import { logTurn } from "../utils/conversationLogger";

const router = Router();
const store = new SessionStore();

function testerResponse(sessionId?: string, agentNotes: string = "tester_ping_no_message") {
  return makeFullSchema({
    status: "success",
    sessionId: sessionId || "tester-session",
    reply: "OK",
    agentNotes
  });
}

router.options("/honeypot", (_req: Request, res: Response) => {
  return res.status(200).json(makeFullSchema({ status: "success", agentNotes: "tester_probe" }));
});

router.get("/honeypot", (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || "tester-session";
  return res.status(200).json(testerResponse(sessionId, "tester_probe_get"));
});

router.post("/honeypot", async (req: Request, res: Response) => {
  const body: any = req.body ?? {};
  const apiKey = req.header("x-api-key");
  const expectedKey = process.env.API_KEY || "";
  if (expectedKey && (!apiKey || apiKey !== expectedKey)) {
    try {
      const pingText = body?.message?.text;
      if (!pingText || typeof pingText !== "string" || pingText.trim().length === 0) {
        console.log("[HONEYPOT][PING] Empty body / tester probe");
      } else {
        const sessionId = body?.sessionId || "tester-session";
        logTurn({ sessionId, turn: 1, role: "SCAMMER", text: pingText });
      }
    } catch {
      // swallow logging errors
    }
    return res.status(200).json(
      makeFullSchema({
        status: "error",
        sessionId: body?.sessionId || "tester-session",
        reply: "OK",
        agentNotes: "Invalid API key"
      })
    );
  }

  const text = body?.message?.text;
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    try {
      console.log("[HONEYPOT][PING] Empty body / tester probe");
    } catch {
      // swallow logging errors
    }
    return res
      .status(200)
      .json(
        makeFullSchema({
          status: "success",
          sessionId: body?.sessionId || "tester-session",
          agentNotes: "tester_ping",
          reply: "OK"
        })
      );
  }

  const bodyTyped = (req.body || {}) as {
    sessionId?: string;
    message?: { sender?: "scammer" | "user"; text?: string; timestamp?: string };
    conversationHistory?: { sender: string; text: string; timestamp: string }[];
    metadata?: { channel?: string; language?: string; locale?: string };
  };

  const nowIso = new Date().toISOString();
  const sessionId = bodyTyped.sessionId || `tester-${Date.now()}`;

  let messageText = "";
  let messageSender: "scammer" | "user" = "scammer";
  let messageTimestamp = nowIso;

  if (bodyTyped.message) {
    messageText = bodyTyped.message.text || "";
    messageSender = bodyTyped.message.sender || "scammer";
    messageTimestamp = bodyTyped.message.timestamp || nowIso;
  }

  if (!messageText) {
    return res.status(200).json(testerResponse(sessionId, "tester_ping_no_message"));
  }

  const conversationHistory = bodyTyped.conversationHistory || [];
  const metadata = bodyTyped.metadata || { channel: "SMS", language: "English", locale: "IN" };

  let session = store.get(sessionId);
  if (!session) {
    session = store.getOrCreate(sessionId, messageTimestamp);
  } else {
    const lastAt = new Date(session.engagement.lastMessageAt).getTime();
    const tooOld = Date.now() - lastAt > 10 * 60 * 1000;
    if (session.engagement.mode === "COMPLETE" || tooOld) {
      session = store.resetSession(session, messageTimestamp);
    }
  }

  const historyTexts = conversationHistory.map((m) => m.text);
  const texts = [messageText, ...historyTexts];

  const turnNumber = Math.max(1, Math.floor(session.engagement.totalMessagesExchanged / 2) + 1);
  logTurn({ sessionId: session.sessionId, turn: turnNumber, role: "SCAMMER", text: messageText });

  const normalized = normalizeText(messageText);
  const extracted = extractIntelligence(texts);
  const merged = mergeIntelligence(session.extractedIntelligence, extracted);

  const scores = computeScores(normalized, session.state);
  const scamDetected =
    scores.scamScore >= 0.6 ||
    merged.suspiciousKeywords.length >= 2 ||
    merged.upiIds.length > 0 ||
    merged.phishingLinks.length > 0 ||
    normalized.includes("otp") ||
    normalized.includes("pin");

  const gotUpiId = merged.upiIds.length > 0;
  const gotPaymentLink = merged.phishingLinks.length > 0;
  const gotPhoneOrEmail = merged.phoneNumbers.length > 0 || merged.emails.length > 0;
  const gotBankAccountLikeDigits = merged.bankAccounts.length > 0;
  const gotPhishingUrl = merged.phishingLinks.length > 0;
  const gotExplicitOtpAsk =
    session.goalFlags.gotExplicitOtpAsk ||
    normalized.includes("otp") ||
    normalized.includes("one time password") ||
    merged.suspiciousKeywords.includes("otp");

  session.goalFlags = {
    gotUpiId: session.goalFlags.gotUpiId || gotUpiId,
    gotPaymentLink: session.goalFlags.gotPaymentLink || gotPaymentLink,
    gotPhoneOrEmail: session.goalFlags.gotPhoneOrEmail || gotPhoneOrEmail,
    gotBankAccountLikeDigits: session.goalFlags.gotBankAccountLikeDigits || gotBankAccountLikeDigits,
    gotPhishingUrl: session.goalFlags.gotPhishingUrl || gotPhishingUrl,
    gotExplicitOtpAsk
  };

  const maxTurns = Number(process.env.MAX_TURNS || 14);
  const planner = planNext({
    scamScore: scores.scamScore,
    stressScore: scores.stressScore,
    scamDetected,
    state: session.state,
    engagement: { totalMessagesExchanged: session.engagement.totalMessagesExchanged },
    extracted: merged,
    story: session.story,
    maxTurns,
    goalFlags: session.goalFlags,
    lastIntents: session.lastIntents
  });

  const summary = summarize(conversationHistory, merged, session.story, session.persona);
  const reply = await writeReplySmart(
    {
      nextIntent: planner.nextIntent,
      state: planner.updatedState,
      stressScore: scores.stressScore,
      lastScammerMessage: messageText,
      story: session.story,
      lastReplies: session.lastReplies,
      turnNumber: session.engagement.totalMessagesExchanged + 1
    },
    session.persona,
    summary,
    generateReplyOpenAI
  );
  logTurn({ sessionId: session.sessionId, turn: turnNumber, role: "HONEYPOT", text: reply });

  const now = new Date().toISOString();
  session.state = planner.updatedState;
  session.extractedIntelligence = merged;
  if (messageSender === "scammer") session.engagement.scammerMessagesReceived += 1;
  session.engagement.agentMessagesSent += 1;
  session.engagement.totalMessagesExchanged =
    session.engagement.scammerMessagesReceived + session.engagement.agentMessagesSent;
  const modeBase = scamDetected ? "SCAM_CONFIRMED" : scores.scamScore >= 0.45 ? "SUSPECT" : "SAFE";
  const finalMode =
    session.engagement.totalMessagesExchanged >= maxTurns ? "COMPLETE" : modeBase;
  session.engagement.mode = finalMode;
  session.engagement.lastMessageAt = now;
  session.agentNotes = `mode=${finalMode}, scamScore=${scores.scamScore.toFixed(
    2
  )}, stressScore=${scores.stressScore.toFixed(2)}, intent=${planner.nextIntent}`;
  session.lastIntents = [...session.lastIntents, planner.nextIntent].slice(-6);
  session.lastReplies = [...session.lastReplies, reply].slice(-5);
  console.log("[TURN]", session.sessionId, {
    scammerMessagesReceived: session.engagement.scammerMessagesReceived,
    agentMessagesSent: session.engagement.agentMessagesSent,
    totalMessagesExchanged: session.engagement.totalMessagesExchanged,
    mode: session.engagement.mode
  });

  if (!session.story.scammerClaim && scores.signals.authority > 0) {
    session.story.scammerClaim = "authority claim";
  }
  if (!session.story.scammerAsk && scores.signals.credential > 0) {
    session.story.scammerAsk = "credential request";
  }
  if (!session.story.scamType && scores.scamScore > 0.6) {
    session.story.scamType = "financial/impersonation";
  }

  store.update(session);

  if (session.engagement.mode === "COMPLETE" && scamDetected) {
    await sendFinalCallback(
      session.sessionId,
      session.engagement.totalMessagesExchanged,
      session.extractedIntelligence,
      session.agentNotes
    );
  }

  return res.json({
    status: "success",
    sessionId: session.sessionId,
    scamDetected,
    scamScore: scores.scamScore,
    stressScore: scores.stressScore,
    engagement: session.engagement,
    reply,
    extractedIntelligence: {
      bankAccounts: merged.bankAccounts,
      upiIds: merged.upiIds,
      phishingLinks: merged.phishingLinks,
      phoneNumbers: merged.phoneNumbers,
      emails: merged.emails,
      suspiciousKeywords: merged.suspiciousKeywords
    },
    agentNotes: session.agentNotes
  });
});

export default router;
