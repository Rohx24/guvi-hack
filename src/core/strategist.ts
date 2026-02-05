export type NextMove = {
  goal: string;
  context: string;
};

export type StrategistInput = {
  scammerText: string;
  extracted: {
    employee_codes: string[];
    case_ids: string[];
    phone_numbers: string[];
    upi_ids: string[];
    bank_accounts: string[];
    links: string[];
  };
  burnt_intents: Set<string>;
};

function hasAny(list: string[], value: string): boolean {
  return list.includes(value);
}

export function chooseNextMove(input: StrategistInput): NextMove {
  const text = input.scammerText.toLowerCase();
  const burned = new Set(input.burnt_intents);

  if (input.extracted.employee_codes.length > 0) burned.add("GET_EMPLOYEE_ID");
  if (input.extracted.case_ids.length > 0) burned.add("GET_CASE_ID");
  if (input.extracted.upi_ids.length > 0) burned.add("GET_UPI");
  if (input.extracted.links.length > 0) burned.add("GET_LINK");

  const mentionsPayment = /(pay|payment|transfer|send money|upi)/.test(text);
  const mentionsVerification = /(verify|verification|kyc)/.test(text);
  const mentionsLink = /(link|http|https|bit\.ly)/.test(text);

  if (mentionsPayment && input.extracted.upi_ids.length === 0 && !hasAny([...burned], "GET_UPI")) {
    return { goal: "GET_UPI", context: "payment_mentioned" };
  }
  if (mentionsVerification && input.extracted.employee_codes.length === 0 && !hasAny([...burned], "GET_EMPLOYEE_ID")) {
    return { goal: "GET_EMPLOYEE_ID", context: "verification_mentioned" };
  }
  if (mentionsLink && input.extracted.links.length === 0 && !hasAny([...burned], "GET_LINK")) {
    return { goal: "GET_LINK", context: "link_mentioned" };
  }

  return { goal: "GET_CASE_ID", context: "fallback" };
}
