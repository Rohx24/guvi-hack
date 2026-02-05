import { StrategistInput, StrategistOutput } from "../utils/types";

function detectPanicPrefix(message: string): string {
  const t = message.toLowerCase();
  if (t.includes("blocked") || t.includes("urgent")) {
    const options = ["Oh god", "Please wait", "I am scared"];
    return options[Math.floor(Math.random() * options.length)];
  }
  return "";
}

function burnForNegatives(message: string, burned: Set<string>): void {
  const t = message.toLowerCase();
  if (/(no ticket|no case id|no case|no reference|dont have ticket|don't have ticket)/.test(t)) {
    burned.add("ask_ticket_or_case_id");
  }
}

export function chooseGoal(input: StrategistInput): StrategistOutput {
  const burned = input.burned;
  const panicPrefix = detectPanicPrefix(input.lastScammerMessage);
  burnForNegatives(input.lastScammerMessage, burned);

  const missingUpi = input.extracted.upi_ids.length === 0;
  const missingEmployee = input.extracted.employee_codes.length === 0;
  const missingCase = input.extracted.case_ids.length === 0;
  const missingPhone = input.extracted.phone_numbers.length === 0;

  if (input.scamScore > 0.9 && missingUpi && !burned.has("ask_upi_or_beneficiary")) {
    return { goal: "ask_upi_or_beneficiary", reason: "high_scam_get_upi", panicPrefix };
  }
  if (missingEmployee && !burned.has("ask_employee_id")) {
    return { goal: "ask_employee_id", reason: "need_employee_id", panicPrefix };
  }
  if (missingCase && !burned.has("ask_ticket_or_case_id")) {
    return { goal: "ask_ticket_or_case_id", reason: "need_case_id", panicPrefix };
  }
  if (!burned.has("ask_branch_city")) {
    return { goal: "ask_branch_city", reason: "need_location", panicPrefix };
  }
  if (!burned.has("ask_callback_number")) {
    return { goal: "ask_callback_number", reason: "need_callback", panicPrefix };
  }
  if (!burned.has("ask_sender_id_or_email")) {
    return { goal: "ask_sender_id_or_email", reason: "need_official_email", panicPrefix };
  }
  if (missingPhone && !burned.has("ask_phone_numbers")) {
    return { goal: "ask_phone_numbers", reason: "need_phone", panicPrefix };
  }

  return { goal: "ask_keywords_used", reason: "fallback", panicPrefix };
}
