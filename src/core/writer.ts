import { SessionState, StorySummary } from "./planner";
import type { Persona } from "./persona";

export type WriterInput = {
  nextIntent:
    | "clarify_procedure"
    | "seek_reassurance"
    | "delay_busy"
    | "pretend_technical_issue"
    | "partial_comply_fake_info"
    | "request_link_or_upi"
    | "ask_for_official_id_softly"
    | "confused_resistance";
  state: SessionState;
  stressScore: number;
  lastScammerMessage: string;
  story: StorySummary;
  lastReplies: string[];
  turnNumber: number;
  phase: "SHOCK" | "PUSHBACK" | "OVERWHELM" | "NEAR_COMPLY" | "EXIT";
  lastFriction: string;
};

const templates: Record<WriterInput["nextIntent"], string[]> = {
  clarify_procedure: [
    "Wait… tell step by step, I’m lost.",
    "I didn’t get it. What first?",
    "Slowly please. One by one.",
    "Explain again? I’m not getting.",
    "I missed it… can you repeat?",
    "What do I do first?",
    "Just say the steps, simple.",
    "I’m stuck, what now?",
    "Tell me again, short.",
    "I’m not clear, then?"
  ],
  seek_reassurance: [
    "Is my account safe right now?",
    "Please don’t block it, okay?",
    "Tell me it will be fine.",
    "Are you sure this fixes it?",
    "It’s already blocked or not?",
    "Please stay on line.",
    "I can’t lose money…",
    "Just confirm once, please.",
    "I’m scared, say it’s okay.",
    "Don’t close it, I’m trying."
  ],
  delay_busy: [
    "I'm outside right now, give me 10 minutes. Don't close the case please.",
    "I'm in meeting, can I do this after some time?",
    "I'm driving now, I will do it shortly.",
    "I'm at office, can you call after 15 minutes?",
    "I'm busy right now, please wait a bit.",
    "I'm in traffic, please hold on.",
    "Can I do this in 20 minutes? I'm outside.",
    "I'm not free now, please don't close it.",
    "I need few minutes, phone battery low.",
    "I'm with family, can we do later?"
  ],
  pretend_technical_issue: [
    "App not opening… error.",
    "Link not loading, net slow.",
    "Page stuck, just spinning.",
    "UPI name showing different.",
    "Paste not working, phone hang.",
    "It says invalid beneficiary.",
    "Payment failed, what now?",
    "Timeout again…",
    "App stuck, I’ll retry.",
    "Something is off, app freezing."
  ],
  partial_comply_fake_info: [
    "OTP not received. Resend?",
    "I entered, it says invalid.",
    "OTP not coming…",
    "Typed and it failed.",
    "Error after submit.",
    "Tried once, nothing.",
    "It says try later.",
    "OTP came and disappeared.",
    "Transaction failed.",
    "UPI asking PIN, I don’t remember."
  ],
  request_link_or_upi: [
    "Okay, please send the link or UPI ID again. I will check now.",
    "Can you share the exact UPI or payment link? I will try from my side.",
    "Please share the correct UPI once more.",
    "Send me the payment link again, I will open.",
    "Can you share the UPI ID clearly? I will copy.",
    "Please resend the link, earlier message not visible.",
    "I couldn't see the UPI properly, please send again.",
    "Kindly share the exact payment link.",
    "Please send the UPI ID once, I will try now.",
    "Share the link/UPI, I'll check quickly."
  ],
  ask_for_official_id_softly: [
    "Sir, for my record can you share your employee ID or office number?",
    "Just to be sure, please share official reference number.",
    "Please share your official ID for verification.",
    "Can you give me office contact or ID number?",
    "Please send your employee ID once.",
    "Kindly share any reference number.",
    "For safety, can you share office number?",
    "Please provide an official ID, just for record.",
    "Can you give me a ticket or reference number?",
    "Please share official details, I will note."
  ],
  confused_resistance: [
    "Wait… why PIN on chat?",
    "Earlier OTP, now PIN?",
    "You already have my details no?",
    "This step feels different…",
    "Why link again? I opened it.",
    "You said verify first, now pay?",
    "Why you need OTP here?",
    "This is new to me…",
    "It’s not how SBI works?",
    "Hmm… I don’t get this.",
    "Why so urgent? It’s making me nervous.",
    "You said call, now only chat?",
    "This is not matching what you said."
  ]
};

const frictionTemplates: Record<string, string[]> = {
  otp_not_received: ["OTP not received.", "OTP not coming.", "OTP came and disappeared."],
  name_mismatch: ["UPI name showing different.", "Beneficiary name not matching.", "Name mismatch on UPI."],
  pin_forgot: ["UPI asking PIN, I don’t remember.", "It asks PIN, I can’t.", "PIN is not coming to mind."],
  app_crash: ["App crashed again.", "App stuck, it closed.", "Phone is hanging now."],
  server_down: ["Server error showing.", "It says try later.", "Timeout again."]
};

function applyPhaseFilter(options: string[], phase: WriterInput["phase"]): string[] {
  if (phase === "OVERWHELM" || phase === "NEAR_COMPLY" || phase === "EXIT") {
    return options.filter((text) => !/sir|ma'am/i.test(text));
  }
  return options;
}

export function writeReply(input: WriterInput): string {
  let options = templates[input.nextIntent] || templates.clarify_procedure;
  if (input.nextIntent === "pretend_technical_issue" || input.nextIntent === "partial_comply_fake_info") {
    const friction = frictionTemplates[input.lastFriction];
    if (friction && friction.length > 0) {
      options = [...friction, ...options];
    }
  }
  options = applyPhaseFilter(options, input.phase);
  const available = options.filter((text) => !input.lastReplies.includes(text));
  const pool = available.length > 0 ? available : options;
  const index = Math.floor(Math.random() * pool.length);
  const selected = pool[index];

  if (input.state.anxiety > 0.7 && input.nextIntent === "clarify_procedure") {
    return "I'm feeling nervous, please explain slowly what I should do.";
  }

  return selected;
}

const forbidden = [
  "scam",
  "fraud",
  "honeypot",
  "ai",
  "bot",
  "phishing",
  "police",
  "complaint",
  "cybercrime",
  "rbi",
  "report"
];

function isValidReply(reply: string, lastReplies: string[]): boolean {
  if (!reply) return false;
  if (reply.length > 240) return false;
  if (reply.split(/\n/).length > 2) return false;
  const lower = reply.toLowerCase();
  if (forbidden.some((word) => lower.includes(word))) return false;
  if (lastReplies.includes(reply)) return false;
  return true;
}

export type OpenAIWriter = (
  input: WriterInput,
  persona: Persona,
  conversationSummary: string
) => Promise<string>;

export async function writeReplySmart(
  input: WriterInput,
  persona: Persona,
  summary: string,
  openaiWriter: OpenAIWriter
): Promise<string> {
  try {
    const reply = await openaiWriter(input, persona, summary);
    if (isValidReply(reply, input.lastReplies)) return reply;
  } catch (err) {
    // fallback below
  }
  return writeReply(input);
}
