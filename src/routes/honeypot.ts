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
import { maskDigits, safeLog, safeStringify, sanitizeHeaders } from "../utils/logging";

const router = Router();
const store = new SessionStore();

function logIncoming(req: Request, body: unknown) {
  try {
    const headers = sanitizeHeaders(req.headers);
    safeLog(`[INCOMING] headers: ${safeStringify(headers, 2000)}`);
    safeLog(`[INCOMING] body: ${safeStringify(body, 2000)}`);
  } catch {
    // swallow logging errors
  }
}

function logScammer(text: string) {
  safeLog(`[SCAMMER] ${maskDigits(text)}`);
}

function logHoneypot(text: string) {
  safeLog(`[HONEYPOT] ${maskDigits(text)}`);
}

function logOutgoing(status: number, responseJson: unknown) {
  safeLog(`[OUTGOING] response_json: ${safeStringify(responseJson, 5000)}`);
  safeLog(`[OUTGOING] status: ${status}`);
}

function testerResponse(sessionId?: string, agentNotes: string = "tester_ping_no_message") {
  return makeFullSchema({
    scamDetected: false,
    totalMessagesExchanged: 0,
    agentNotes
  });
}

router.options("/honeypot", (_req: Request, res: Response) => {
  return res.status(200).json(makeFullSchema({ agentNotes: "tester_probe" }));
});

router.get("/honeypot", (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || "tester-session";
  return res.status(200).json(testerResponse(sessionId, "tester_probe_get"));
});

router.post("/honeypot", async (req: Request, res: Response) => {
  const body: any = req.body ?? {};
  logIncoming(req, body);

  const text =
    typeof body?.message?.text === "string"
      ? body.message.text
      : typeof body?.text === "string"
      ? body.text
      : typeof body?.message === "string"
      ? body.message
      : "";
  let loggedScammer = false;
  if (text && typeof text === "string" && text.trim().length > 0) {
    logScammer(text);
    loggedScammer = true;
  }

  const apiKey = req.header("x-api-key");
  const expectedKey = process.env.API_KEY || "";
  if (expectedKey && (!apiKey || apiKey !== expectedKey)) {
    const responseJson = makeFullSchema({ agentNotes: "Invalid API key" });
    logOutgoing(401, responseJson);
    return res.status(401).json(responseJson);
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    const responseJson = makeFullSchema({ agentNotes: "tester_ping" });
    logOutgoing(200, responseJson);
    return res.status(200).json(responseJson);
  }

  try {
    const bodyTyped = (req.body || {}) as {
      sessionId?: string;
      message?: { sender?: "scammer" | "user"; text?: string; timestamp?: string };
      conversationHistory?: { sender: string; text: string; timestamp: string }[];
      metadata?: { channel?: string; language?: string; locale?: string };
    };

    const nowIso = new Date().toISOString();
    const sessionId = bodyTyped.sessionId || `tester-${Date.now()}`;

    let messageText = text;
    let messageSender: "scammer" | "user" = "scammer";
    let messageTimestamp = nowIso;

    if (bodyTyped.message) {
      messageText = bodyTyped.message.text || "";
      messageSender = bodyTyped.message.sender || "scammer";
      messageTimestamp = bodyTyped.message.timestamp || nowIso;
    }

    if (!messageText) {
      const responseJson = testerResponse(sessionId, "tester_ping_no_message");
      logOutgoing(200, responseJson);
      return res.status(200).json(responseJson);
    }

    const conversationHistory = bodyTyped.conversationHistory || [];

    let session = store.get(sessionId);
    if (!session) {
      session = store.getOrCreate(sessionId, messageTimestamp);
    } else {
      const lastAt = new Date(session.engagement.lastMessageAt).getTime();
      const tooOld = Date.now() - lastAt > 10 * 60 * 1000;
      const emptyHistory =
        (!conversationHistory || conversationHistory.length === 0) &&
        session.engagement.totalMessagesExchanged > 0;
      if (session.engagement.mode === "COMPLETE" || tooOld || emptyHistory) {
        session = store.resetSession(session, messageTimestamp);
      }
    }

    const historyTexts = conversationHistory.map((m) => m.text);
    const texts = [messageText, ...historyTexts];

    if (!loggedScammer) {
      logScammer(messageText);
      loggedScammer = true;
    }

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
    logHoneypot(reply);

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
    safeLog(
      `[TURN] ${safeStringify(
        {
          sessionId: session.sessionId,
          scammerMessagesReceived: session.engagement.scammerMessagesReceived,
          agentMessagesSent: session.engagement.agentMessagesSent,
          totalMessagesExchanged: session.engagement.totalMessagesExchanged,
          mode: session.engagement.mode
        },
        2000
      )}`
    );

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

    const responseJson = makeFullSchema({
      scamDetected,
      totalMessagesExchanged: session.engagement.totalMessagesExchanged,
      extractedIntelligence: {
        bankAccounts: merged.bankAccounts,
        upiIds: merged.upiIds,
        phishingLinks: merged.phishingLinks,
        phoneNumbers: merged.phoneNumbers,
        suspiciousKeywords: merged.suspiciousKeywords
      },
      agentNotes: session.agentNotes
    });
    logOutgoing(200, responseJson);
    return res.status(200).json(responseJson);
  } catch (err) {
    const normalized = String(text || "").toLowerCase();
    const fallbackScamDetected =
      /otp|pin/.test(normalized) || /urgent|immediately|blocked|suspended/.test(normalized);
    const historyLen = Array.isArray(body?.conversationHistory)
      ? body.conversationHistory.length
      : 0;
    const totalMessagesExchanged = text ? historyLen + 1 : historyLen;
    const responseJson = makeFullSchema({
      scamDetected: fallbackScamDetected,
      totalMessagesExchanged,
      agentNotes: "fallback due to internal error"
    });
    logOutgoing(200, responseJson);
    return res.status(200).json(responseJson);
  }
});

export default router;
