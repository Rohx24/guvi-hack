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
    emails?: string[];
  };
  burnt_intents: Set<string>;
  repeatDemand?: boolean;
};

function hasAny(set: Set<string>, value: string): boolean {
  return set.has(value);
}

function scammerRefusedCase(text: string): boolean {
  return /(no case id|no ticket|cannot provide case|don't have case|cant provide case)/.test(text);
}

export function chooseNextMove(input: StrategistInput): NextMove {
  const text = input.scammerText.toLowerCase();
  const burned = new Set(input.burnt_intents);

  if (input.extracted.employee_codes.length > 0) burned.add("GET_EMPLOYEE_ID");
  if (input.extracted.case_ids.length > 0) burned.add("GET_CASE_ID");
  if (input.extracted.upi_ids.length > 0) burned.add("GET_UPI");
  if (input.extracted.links.length > 0) burned.add("GET_LINK");
  if (input.extracted.phone_numbers.length > 0) burned.add("GET_CALLBACK");
  if (input.extracted.emails && input.extracted.emails.length > 0) burned.add("GET_EMAIL");
  if (scammerRefusedCase(text)) burned.add("GET_CASE_ID");

  const mentionsPayment = /(pay|payment|transfer|send money|upi|beneficiary|merchant)/.test(text);
  const mentionsVerification = /(verify|verification|kyc)/.test(text);
  const mentionsLink = /(link|http|https|bit\.ly)/.test(text);

  if (mentionsPayment && input.extracted.upi_ids.length === 0 && !hasAny(burned, "GET_UPI")) {
    return { goal: "GET_UPI", context: "payment_mentioned" };
  }
  if (mentionsVerification && input.extracted.employee_codes.length === 0 && !hasAny(burned, "GET_EMPLOYEE_ID")) {
    return { goal: "GET_EMPLOYEE_ID", context: "verification_mentioned" };
  }
  if (mentionsLink && input.extracted.links.length === 0 && !hasAny(burned, "GET_LINK")) {
    return { goal: "GET_LINK", context: "link_mentioned" };
  }

  const priority: string[] = [
    "GET_LINK",
    "GET_CALLBACK",
    "GET_EMAIL",
    "GET_UPI",
    "GET_EMPLOYEE_ID",
    "GET_BRANCH",
    "GET_CASE_ID"
  ];

  for (const goal of priority) {
    if (!hasAny(burned, goal)) {
      return { goal, context: "priority_pivot" };
    }
  }

  return { goal: "GET_CASE_ID", context: "fallback" };
}
