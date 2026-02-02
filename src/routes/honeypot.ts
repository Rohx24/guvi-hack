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
  const body = req.body as {
    sessionId?: string;
    message?: { sender?: "scammer" | "user"; text?: string; timestamp?: string };
    conversationHistory?: { sender: string; text: string; timestamp: string }[];
    metadata?: { channel?: string; language?: string; locale?: string };
  };

  if (!body.sessionId) return badRequest(res, "Missing sessionId");
  if (!body.message?.text || !body.message?.sender || !body.message?.timestamp) {
    return badRequest(res, "Missing message fields");
  }

  const session = store.getOrCreate(body.sessionId, body.message.timestamp);

  const historyTexts = (body.conversationHistory || []).map((m) => m.text);
  const texts = [body.message.text, ...historyTexts];

  const normalized = normalizeText(body.message.text);
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
    state: session.state,
    engagement: { totalMessagesExchanged: projectedTotal },
    extracted: merged,
    story: session.story,
    maxTurns,
    goalFlags: session.goalFlags,
    lastIntents: session.lastIntents
  });

  const summary = summarize(body.conversationHistory || [], merged, session.story, session.persona);
  const reply = await writeReplySmart(
    {
      nextIntent: planner.nextIntent,
      state: planner.updatedState,
      stressScore: scores.stressScore,
      lastScammerMessage: body.message.text,
      story: session.story,
      lastReplies: session.lastReplies,
      turnNumber: projectedTotal
    },
    session.persona,
    summary,
    generateReplyOpenAI
  );

  const now = new Date().toISOString();
  session.state = planner.updatedState;
  session.extractedIntelligence = merged;
  session.engagement.totalMessagesExchanged = projectedTotal;
  if (body.message.sender === "scammer") session.engagement.scammerMessagesReceived += 1;
  if (body.message.sender === "scammer") session.engagement.agentMessagesSent += 1;
  session.engagement.mode = planner.mode;
  session.engagement.lastMessageAt = now;
  session.agentNotes = planner.agentNotes;
  session.lastIntents = [...session.lastIntents, planner.nextIntent].slice(-6);
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
