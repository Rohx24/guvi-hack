import { Router, Request, Response } from "express";
import { extractIntelligence, mergeIntelligence, normalizeText } from "../core/extractor";
import { computeScores } from "../core/scoring";
import { planNext } from "../core/planner";
import { writeReplySmart } from "../core/writer";
import { SessionStore } from "../core/sessionStore";
import { sendFinalCallback } from "../core/callback";
import { summarize } from "../core/summarizer";
import { generateReplyOpenAI } from "../core/openaiWriter";

const router = Router();
const store = new SessionStore();

function badRequest(res: Response, message: string) {
  return res.status(400).json({ status: "error", message });
}

function testerResponse(sessionId?: string, agentNotes: string = "tester_ping_no_message") {
  const now = new Date().toISOString();
  return {
    status: "success",
    sessionId: sessionId || "tester-session",
    scamDetected: false,
    scamScore: 0,
    stressScore: 0,
    engagement: {
      mode: "SAFE",
      totalMessagesExchanged: 0,
      agentMessagesSent: 0,
      scammerMessagesReceived: 0,
      startedAt: now,
      lastMessageAt: now
    },
    reply: "OK",
    extractedIntelligence: {
      bankAccounts: [],
      upiIds: [],
      phishingLinks: [],
      phoneNumbers: [],
      emails: [],
      suspiciousKeywords: []
    },
    agentNotes
  };
}

router.post("/honeypot", async (req: Request, res: Response) => {
  const body: any = req.body ?? {};
  const text = body?.message?.text;
  if (!text || typeof text !== "string") {
    return res.status(200).json(testerResponse(body?.sessionId));
  }

  const bodyTyped = (req.body || {}) as {
    sessionId?: string;
    message?: { sender?: "scammer" | "user"; text?: string; timestamp?: string } | string;
    text?: string;
    conversationHistory?: { sender: string; text: string; timestamp: string }[];
    metadata?: { channel?: string; language?: string; locale?: string };
  };

  const nowIso = new Date().toISOString();
  const sessionId = bodyTyped.sessionId || `tester-${Date.now()}`;

  let messageText = "";
  let messageSender: "scammer" | "user" = "scammer";
  let messageTimestamp = nowIso;

  if (typeof bodyTyped.message === "string") {
    messageText = bodyTyped.message;
  } else if (bodyTyped.message) {
    messageText = bodyTyped.message.text || "";
    messageSender = bodyTyped.message.sender || "scammer";
    messageTimestamp = bodyTyped.message.timestamp || nowIso;
  } else if (bodyTyped.text) {
    messageText = bodyTyped.text;
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
    const emptyHistory = (!conversationHistory || conversationHistory.length === 0) &&
      session.engagement.totalMessagesExchanged > 0;
    if (session.engagement.mode === "COMPLETE" || tooOld || emptyHistory) {
      session = store.resetSession(session, messageTimestamp);
    }
  }

  const historyTexts = conversationHistory.map((m) => m.text);
  const texts = [messageText, ...historyTexts];

  const normalized = normalizeText(messageText);
  const extracted = extractIntelligence(texts);
  const merged = mergeIntelligence(session.extractedIntelligence, extracted);

  const scores = computeScores(normalized, session.state);

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

  const now = new Date().toISOString();
  session.state = planner.updatedState;
  session.extractedIntelligence = merged;
  if (messageSender === "scammer") session.engagement.scammerMessagesReceived += 1;
  session.engagement.agentMessagesSent += 1;
  session.engagement.totalMessagesExchanged =
    session.engagement.scammerMessagesReceived + session.engagement.agentMessagesSent;
  session.engagement.mode = planner.mode;
  session.engagement.lastMessageAt = now;
  session.agentNotes = planner.agentNotes;
  session.lastIntents = [...session.lastIntents, planner.nextIntent].slice(-6);
  session.lastReplies = [...session.lastReplies, reply].slice(-3);
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

  if (planner.mode === "COMPLETE" && planner.scamDetected) {
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
    scamDetected: planner.scamDetected,
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
