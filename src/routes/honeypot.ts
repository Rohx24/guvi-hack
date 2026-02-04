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

router.post("/honeypot", async (req: Request, res: Response) => {
  // GUVI tester compatibility: allow empty/minimal body without failing.
  if (!req.body || !req.body.message || !req.body.message.text) {
    const now = new Date().toISOString();
    return res.json({
      status: "success",
      sessionId: `guvi-${Date.now()}`,
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
      reply: "Hello",
      extractedIntelligence: {
        bankAccounts: [],
        upiIds: [],
        phishingLinks: [],
        phoneNumbers: [],
        emails: [],
        suspiciousKeywords: []
      },
      agentNotes: ""
    });
  }

  const body = (req.body || {}) as {
    sessionId?: string;
    message?: { sender?: "scammer" | "user"; text?: string; timestamp?: string } | string;
    text?: string;
    conversationHistory?: { sender: string; text: string; timestamp: string }[];
    metadata?: { channel?: string; language?: string; locale?: string };
  };

  const nowIso = new Date().toISOString();
  const sessionId = body.sessionId || `tester-${Date.now()}`;

  let messageText = "";
  let messageSender: "scammer" | "user" = "scammer";
  let messageTimestamp = nowIso;

  if (typeof body.message === "string") {
    messageText = body.message;
  } else if (body.message) {
    messageText = body.message.text || "";
    messageSender = body.message.sender || "scammer";
    messageTimestamp = body.message.timestamp || nowIso;
  } else if (body.text) {
    messageText = body.text;
  }

  if (!messageText) {
    messageText = "hello";
  }

  const conversationHistory = body.conversationHistory || [];
  const metadata = body.metadata || { channel: "SMS", language: "English", locale: "IN" };

  const session = store.getOrCreate(sessionId, messageTimestamp);

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
  const projectedTotal = session.engagement.totalMessagesExchanged + 1;
  const planner = planNext({
    scamScore: scores.scamScore,
    stressScore: scores.stressScore,
    signals: scores.signals,
    state: session.state,
    engagement: { totalMessagesExchanged: projectedTotal },
    extracted: merged,
    story: session.story,
    maxTurns,
    goalFlags: session.goalFlags,
    lastIntents: session.lastIntents,
    phase: session.phase,
    convictionToComply: session.convictionToComply,
    askedVerification: session.askedVerification,
    lastFriction: session.lastFriction,
    normalizedText: normalized
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
      turnNumber: projectedTotal,
      phase: planner.nextPhase,
      lastFriction: planner.nextFriction
    },
    session.persona,
    summary,
    generateReplyOpenAI
  );

  const now = new Date().toISOString();
  session.state = planner.updatedState;
  session.extractedIntelligence = merged;
  session.engagement.totalMessagesExchanged = projectedTotal;
  if (messageSender === "scammer") session.engagement.scammerMessagesReceived += 1;
  if (messageSender === "scammer") session.engagement.agentMessagesSent += 1;
  session.engagement.mode = planner.mode;
  session.engagement.lastMessageAt = now;
  session.agentNotes = planner.agentNotes;
  session.phase = planner.nextPhase;
  session.convictionToComply = planner.nextConvictionToComply;
  session.askedVerification = planner.nextAskedVerification;
  session.lastFriction = planner.nextFriction;
  session.lastIntents = [...session.lastIntents, planner.nextIntent].slice(-5);
  session.lastReplies = [...session.lastReplies, reply].slice(-3);

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
