import { Router, Request, Response } from "express";
import { extractIntelligence, mergeIntelligence, normalizeText } from "../core/extractor";
import { computeScores } from "../core/scoring";
import { advanceEngagementStage, detectEngagementSignals, planNext, Intent } from "../core/planner";
import { isReplySafe, writeReply, writeReplySmart } from "../core/writer";
import { SessionMessage, SessionStore } from "../core/sessionStore";
import { sendFinalCallback } from "../core/callback";
import { summarize } from "../core/summarizer";
import { generateReplyOpenAI } from "../core/openaiWriter";
import { generateReplyAuditorGeneral } from "../core/auditorGeneral";
import { logDecision, logMessage } from "../core/supabase";
import {
  maskDigits,
  safeLog,
  safeStringify,
  sanitizeHeaders,
  truncateForLog
} from "../utils/logging";

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
  const maxLen = process.env.DEBUG === "true" ? 2000 : 200;
  safeLog(`[SCAMMER] ${truncateForLog(maskDigits(text), maxLen)}`);
}

function logHoneypot(text: string) {
  const maxLen = process.env.DEBUG === "true" ? 2000 : 200;
  safeLog(`[HONEYPOT] ${truncateForLog(maskDigits(text), maxLen)}`);
}

function logOutgoing(status: number, responseJson: unknown) {
  safeLog(`[OUTGOING] response_json: ${safeStringify(responseJson, 5000)}`);
  safeLog(`[OUTGOING] status: ${status}`);
}

function turnResponse(reply: string) {
  return { status: "success", reply };
}

function computePhase(asked: Set<string>): string {
  const phases: Array<{ label: string; intents: string[] }> = [
    {
      label: "Phase 1",
      intents: ["ask_ticket_or_case_id", "ask_branch_city", "ask_department_name"]
    },
    {
      label: "Phase 2",
      intents: ["ask_employee_id", "ask_designation", "ask_callback_number", "ask_escalation_authority"]
    },
    {
      label: "Phase 3",
      intents: ["ask_transaction_amount_time", "ask_transaction_mode", "ask_merchant_receiver"]
    },
    {
      label: "Phase 4",
      intents: ["ask_device_type", "ask_login_location", "ask_ip_or_reason"]
    },
    {
      label: "Phase 5",
      intents: ["ask_otp_reason", "ask_no_notification_reason", "ask_internal_system"]
    },
    {
      label: "Phase 6",
      intents: ["ask_phone_numbers", "ask_sender_id_or_email", "ask_links", "ask_upi_or_beneficiary", "ask_names_used", "ask_keywords_used"]
    }
  ];
  for (const phase of phases) {
    const pending = phase.intents.some((intent) => !asked.has(intent));
    if (pending) return phase.label;
  }
  return "Phase 6";
}


router.options("/honeypot", (_req: Request, res: Response) => {
  return res.status(200).json(turnResponse("OK"));
});

router.options("/conversation", (_req: Request, res: Response) => {
  return res.status(200).json(turnResponse("OK"));
});

router.get("/honeypot", (_req: Request, res: Response) => {
  return res.status(200).json(turnResponse("OK"));
});

router.get("/conversation", (_req: Request, res: Response) => {
  return res.status(200).json(turnResponse("OK"));
});

const handleHoneypot = async (req: Request, res: Response) => {
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
    const responseJson = turnResponse("OK");
    logOutgoing(200, responseJson);
    return res.status(200).json(responseJson);
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    const responseJson = turnResponse("OK");
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
      const responseJson = turnResponse("OK");
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
      if (tooOld || emptyHistory) {
        session = store.resetSession(session, messageTimestamp);
      }
    }

    if (session.messages.length === 0 && conversationHistory.length > 0) {
      const seedMessages: SessionMessage[] = conversationHistory.map((m) => ({
        sender: m.sender === "scammer" ? "scammer" : "honeypot",
        text: m.text,
        timestamp: m.timestamp || nowIso
      }));
      session.messages = seedMessages.slice(-30);
    }

    session.messages.push({ sender: "scammer", text: messageText, timestamp: messageTimestamp });
    if (session.messages.length > 30) {
      session.messages = session.messages.slice(-30);
    }
    void logMessage({
      sessionId: session.sessionId,
      turnIndex: session.engagement.totalMessagesExchanged + 1,
      sender: "scammer",
      text: messageText,
      timestamp: messageTimestamp,
      channel: bodyTyped.metadata?.channel,
      scenario: bodyTyped.metadata?.channel || "default"
    });

    const historyTexts = conversationHistory.map((m) => m.text);
    const texts = [messageText, ...historyTexts];

    if (!loggedScammer) {
      logScammer(messageText);
      loggedScammer = true;
    }

    const normalized = normalizeText(messageText);
    const maxTurns = Number(process.env.MAX_TURNS || 12);
    const scammerMessages = session.messages
      .filter((m) => m.sender === "scammer")
      .map((m) => m.text);
    const engagementSignals = detectEngagementSignals(scammerMessages);
    const turnCount = session.engagement.totalMessagesExchanged + 1;
    session.engagementStage = advanceEngagementStage(session.engagementStage || "CONFUSED", {
      ...engagementSignals,
      turnCount
    });
    const extracted = extractIntelligence(texts);
    const extractedCurrent = extractIntelligence([messageText]);
    const merged = mergeIntelligence(session.extractedIntelligence, extracted);

    const scores = computeScores(normalized, session.state);
    const scamDetected =
      scores.scamScore >= 0.6 ||
      merged.suspiciousKeywords.length >= 2 ||
      merged.upiIds.length > 0 ||
      merged.phishingLinks.length > 0 ||
      normalized.includes("otp") ||
      normalized.includes("pin");
    session.scamDetected = scamDetected;

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

    for (const id of extractedCurrent.employeeIds) session.facts.employeeIds.add(id);
    for (const phone of extractedCurrent.phoneNumbers) session.facts.phoneNumbers.add(phone);
    for (const link of extractedCurrent.phishingLinks) session.facts.links.add(link);
    for (const upi of extractedCurrent.upiIds) session.facts.upiIds.add(upi);
    for (const caseId of extractedCurrent.caseIds) session.facts.caseIds.add(caseId);
    for (const toll of extractedCurrent.tollFreeNumbers)
      session.facts.tollFreeNumbers.add(toll);
    for (const senderId of extractedCurrent.senderIds) session.facts.senderIds.add(senderId);
    if (/\bsbi\b/.test(normalized)) session.facts.orgNames.add("sbi");
    if (/\bhdfc\b/.test(normalized)) session.facts.orgNames.add("hdfc");
    if (/\bicici\b/.test(normalized)) session.facts.orgNames.add("icici");
    if (/\baxis\b/.test(normalized)) session.facts.orgNames.add("axis");
    if (/\bkotak\b/.test(normalized)) session.facts.orgNames.add("kotak");
    if (/\bpaytm\b/.test(normalized)) session.facts.orgNames.add("paytm");
    if (/\bphonepe\b/.test(normalized)) session.facts.orgNames.add("phonepe");
    if (/\bgpay\b/.test(normalized) || /google pay/.test(normalized)) {
      session.facts.orgNames.add("gpay");
    }
    if (/amazon pay/.test(normalized)) session.facts.orgNames.add("amazonpay");
    session.facts.hasEmployeeId = session.facts.employeeIds.size > 0;
    session.facts.hasPhone = session.facts.phoneNumbers.size > 0;
    session.facts.hasLink = session.facts.links.size > 0;
    session.facts.hasUpi = session.facts.upiIds.size > 0;
    if (session.facts.caseIds.size > 0) session.askedQuestions.add("ask_ticket_or_case_id");
    if (session.facts.employeeIds.size > 0) session.askedQuestions.add("ask_employee_id");
    if (session.facts.tollFreeNumbers.size > 0 || session.facts.hasPhone) {
      session.askedQuestions.add("ask_callback_number");
      session.askedQuestions.add("ask_phone_numbers");
    }
    if (session.facts.senderIds.size > 0) session.askedQuestions.add("ask_sender_id_or_email");
    if (session.facts.hasLink) session.askedQuestions.add("ask_links");
    if (session.facts.hasUpi) session.askedQuestions.add("ask_upi_or_beneficiary");

    const summaryBits: string[] = [];
    if (scamDetected) summaryBits.push("Scammer likely fraud");
    if (merged.phishingLinks.length > 0) summaryBits.push("sent link");
    if (normalized.includes("otp") || normalized.includes("pin")) summaryBits.push("asks OTP/PIN");
    if (merged.upiIds.length > 0) summaryBits.push("UPI shared");
    if (merged.phoneNumbers.length > 0) summaryBits.push("phone shared");
    if (merged.employeeIds.length > 0) summaryBits.push("employee id given");
    if (summaryBits.length > 0) {
      let newSummary = summaryBits.join(", ");
      if (newSummary.length > 160) newSummary = `${newSummary.slice(0, 157)}...`;
      session.runningSummary = newSummary;
    }

    const planner = planNext({
      scamScore: scores.scamScore,
      stressScore: scores.stressScore,
      scamDetected,
      state: session.state,
      engagement: { totalMessagesExchanged: session.engagement.totalMessagesExchanged },
      extracted: merged,
      askedQuestions: session.askedQuestions,
      lastIntents: session.lastIntents
    });

    const summary =
      session.runningSummary || summarize(conversationHistory, merged, session.story, session.persona);
    let reply = "";
    let councilNotes = "";
    let chosenIntent = "none";
    const writerInput = {
      nextIntent: planner.nextIntent,
      state: planner.updatedState,
      stressScore: scores.stressScore,
      lastScammerMessage: messageText,
      story: session.story,
      lastReplies: session.lastReplies,
      turnNumber: session.engagement.totalMessagesExchanged + 1,
      extracted: merged,
      facts: session.facts,
      engagementStage: session.engagementStage,
      askedQuestions: session.askedQuestions,
      maxTurns
    };
    const councilEnabled = process.env.COUNCIL_MODE !== "false";
    if (councilEnabled) {
      const audit = await generateReplyAuditorGeneral({
        sessionId: session.sessionId,
        lastScammerMessage: messageText,
        conversationHistory,
        extractedIntel: merged,
        facts: session.facts,
        engagementStage: session.engagementStage || "CONFUSED",
        askedQuestions: session.askedQuestions || new Set<string>(),
        lastReplies: session.lastReplies,
        turnIndex: session.engagement.totalMessagesExchanged + 1,
        maxTurns,
        scamScore: scores.scamScore,
        stressScore: scores.stressScore,
        signals: engagementSignals,
        scenario: bodyTyped.metadata?.channel || "default",
        channel: bodyTyped.metadata?.channel
      });
      reply = audit.reply;
      chosenIntent = audit.chosenIntent || "none";
      councilNotes = audit.notes || "";
    } else {
      reply = await writeReplySmart(writerInput, session.persona, summary, generateReplyOpenAI);
    }
    if (
      !isReplySafe(reply, {
        lastReplies: session.lastReplies,
        engagementStage: session.engagementStage || "CONFUSED",
        lastScammerMessage: messageText,
        facts: session.facts,
        turnIndex: session.engagement.totalMessagesExchanged + 1,
        maxTurns
      })
    ) {
      reply = writeReply(writerInput);
      councilNotes = councilNotes ? `${councilNotes}, fallback=writer` : "fallback=writer";
      chosenIntent = chosenIntent || "none";
    }
    if (!reply || reply.trim().length === 0) {
      reply = "OK";
    }
    logHoneypot(reply);

    session.messages.push({ sender: "honeypot", text: reply, timestamp: nowIso });
    if (session.messages.length > 30) {
      session.messages = session.messages.slice(-30);
    }
    if (chosenIntent && chosenIntent !== "none") {
      session.askedQuestions.add(chosenIntent);
    }
    session.conversationPhase = computePhase(session.askedQuestions);
    void logMessage({
      sessionId: session.sessionId,
      turnIndex: turnCount,
      sender: "honeypot",
      text: reply,
      timestamp: nowIso,
      channel: bodyTyped.metadata?.channel,
      scenario: bodyTyped.metadata?.channel || "default"
    });
    void logDecision({
      sessionId: session.sessionId,
      turnIndex: turnCount,
      stage: session.engagementStage || "CONFUSED",
      chosenIntent: chosenIntent || planner.nextIntent,
      reply
    });

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
    const baseNotes = `mode=${finalMode}, scamScore=${scores.scamScore.toFixed(
      2
    )}, stressScore=${scores.stressScore.toFixed(2)}, intent=${planner.nextIntent}`;
    session.agentNotes = councilNotes ? `${baseNotes}, ${councilNotes}` : baseNotes;
    const intentToStore: Intent =
      chosenIntent && chosenIntent !== "none" ? (chosenIntent as Intent) : planner.nextIntent;
    session.lastIntents = [...session.lastIntents, intentToStore].slice(-6);
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

    const repeatsDemand =
      engagementSignals.urgencyRepeat || engagementSignals.sameDemandRepeat || engagementSignals.pushyRepeat;
    const intelScore = [
      session.facts.caseIds.size > 0,
      session.facts.employeeIds.size > 0,
      session.facts.phoneNumbers.size > 0 || session.facts.tollFreeNumbers.size > 0,
      session.facts.upiIds.size > 0 || session.facts.links.size > 0,
      session.facts.senderIds.size > 0
    ].filter(Boolean).length;
    const enoughIntel = intelScore >= 2;
    const callbackDue =
      scamDetected &&
      (session.engagement.totalMessagesExchanged >= maxTurns ||
        (session.engagement.totalMessagesExchanged >= 8 && repeatsDemand && enoughIntel));
    if (callbackDue && !session.callbackSent && !session.callbackInFlight) {
      session.callbackInFlight = true;
      store.update(session);
      void sendFinalCallback(
        session.sessionId,
        session.engagement.totalMessagesExchanged,
        session.extractedIntelligence,
        session.agentNotes
      ).then((result) => {
        const latest = store.get(session.sessionId);
        if (!latest) return;
        if (result.ok) latest.callbackSent = true;
        latest.callbackInFlight = false;
        store.update(latest);
      });
    }

    const responseJson = turnResponse(reply);
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
    const responseJson = turnResponse(
      fallbackScamDetected
        ? "Why OTP on chat? Give me the ticket number."
        : "This is confusing. Do you have a reference number?"
    );
    logOutgoing(200, responseJson);
    return res.status(200).json(responseJson);
  }
};

router.post("/honeypot", handleHoneypot);
router.post("/conversation", handleHoneypot);

export default router;
