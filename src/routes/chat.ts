import { Router, Request, Response } from "express";
import { analyzeMessage } from "../core/analyst";
import { chooseGoal } from "../core/strategist";
import { generateAgentReply } from "../core/agent";
import { SessionStore } from "../core/sessionStore";
import { LlmExtraction } from "../utils/types";
import { safeLog } from "../utils/logging";

const router = Router();
const store = new SessionStore();

const emptyExtraction: LlmExtraction = {
  employee_codes: [],
  case_ids: [],
  phone_numbers: [],
  upi_ids: [],
  bank_account_digits: []
};

function turnResponse(reply: string) {
  return { status: "success", reply };
}

function burnFromExtraction(extracted: LlmExtraction): Set<string> {
  const burned = new Set<string>();
  if (extracted.employee_codes.length > 0) burned.add("ask_employee_id");
  if (extracted.case_ids.length > 0) burned.add("ask_ticket_or_case_id");
  if (extracted.upi_ids.length > 0) burned.add("ask_upi_or_beneficiary");
  return burned;
}

router.post("/chat", async (req: Request, res: Response) => {
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

  const nowIso = new Date().toISOString();
  const sessionId = body.sessionId || `tester-${Date.now()}`;
  const session = store.getOrCreate(sessionId, nowIso);

  const prior = {
    employee_codes: session.extractedIntelligence.employeeIds || [],
    case_ids: session.extractedIntelligence.caseIds || [],
    phone_numbers: session.extractedIntelligence.phoneNumbers || [],
    upi_ids: session.extractedIntelligence.upiIds || [],
    bank_account_digits: session.extractedIntelligence.bankAccounts || []
  };

  const analyst = await analyzeMessage(text, prior, 1200);
  const burned = burnFromExtraction(analyst.extracted);

  // merge back into session store
  session.extractedIntelligence.employeeIds = analyst.extracted.employee_codes;
  session.extractedIntelligence.caseIds = analyst.extracted.case_ids;
  session.extractedIntelligence.phoneNumbers = analyst.extracted.phone_numbers;
  session.extractedIntelligence.upiIds = analyst.extracted.upi_ids;
  session.extractedIntelligence.bankAccounts = analyst.extracted.bank_account_digits;

  const strategist = chooseGoal({
    scamScore: analyst.scamScore,
    extracted: analyst.extracted,
    burned,
    lastScammerMessage: text
  });

  const reply = await generateAgentReply(strategist.goal, text, strategist.panicPrefix, 1200);
  safeLog(
    `[CHAT] ${JSON.stringify({
      sessionId,
      scamScore: analyst.scamScore,
      goal: strategist.goal
    })}`
  );

  session.lastReplyTexts = [...session.lastReplyTexts, reply].slice(-5);
  session.lastIntents = [...session.lastIntents, strategist.goal as any].slice(-6);
  session.engagement.totalMessagesExchanged += 1;
  session.engagement.lastMessageAt = nowIso;
  store.update(session);

  return res.status(200).json(turnResponse(reply));
});

export default router;
