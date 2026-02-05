import { StrategistInput, StrategistOutput } from "../utils/types";

export function chooseGoal(input: StrategistInput): StrategistOutput {
  const burned = input.burned;

  const missingUpi = input.extracted.upi_ids.length === 0;
  const missingEmployee = input.extracted.employee_codes.length === 0;
  const missingCase = input.extracted.case_ids.length === 0;
  const missingPhone = input.extracted.phone_numbers.length === 0;

  if (input.scamScore > 0.9 && missingUpi && !burned.has("ask_upi_or_beneficiary")) {
    return { goal: "ask_upi_or_beneficiary", reason: "high_scam_get_upi" };
  }
  if (missingEmployee && !burned.has("ask_employee_id")) {
    return { goal: "ask_employee_id", reason: "need_employee_id" };
  }
  if (missingCase && !burned.has("ask_ticket_or_case_id")) {
    return { goal: "ask_ticket_or_case_id", reason: "need_case_id" };
  }
  if (!burned.has("ask_branch_city")) {
    return { goal: "ask_branch_city", reason: "need_location" };
  }
  if (!burned.has("ask_callback_number")) {
    return { goal: "ask_callback_number", reason: "need_callback" };
  }
  if (!burned.has("ask_sender_id_or_email")) {
    return { goal: "ask_sender_id_or_email", reason: "need_official_email" };
  }
  if (missingPhone && !burned.has("ask_phone_numbers")) {
    return { goal: "ask_phone_numbers", reason: "need_phone" };
  }

  return { goal: "ask_keywords_used", reason: "fallback" };
}
