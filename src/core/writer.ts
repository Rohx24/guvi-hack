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
};

const templates: Record<WriterInput["nextIntent"], string[]> = {
  clarify_procedure: [
    "Sir, I'm a bit confused. Please tell step by step what to do.",
    "I'm not understanding properly, can you explain the process again?",
    "Please guide me slowly, I'm getting mixed up.",
    "Sorry, I didn't get it. What should I do first?",
    "I'm worried and confused. Can you explain once more?",
    "Please repeat the steps, I'm not clear.",
    "I'm not very technical, tell me in simple way.",
    "One by one steps please, I am little nervous.",
    "Can you explain again, I don't want to do wrong?",
    "I got confused, please guide me properly."
  ],
  seek_reassurance: [
    "I'm getting worried, is my account safe? Please confirm once.",
    "Please don't block anything, I will do it. Just guide me calmly.",
    "I'm scared a bit, will this fix the issue?",
    "Please assure me, I don't want any problem.",
    "Is my account already blocked? Please say.",
    "I'm tense, just tell me I'm safe.",
    "Please confirm nothing bad will happen.",
    "I'm worried about money, please guide me.",
    "I'm not sure, please confirm once.",
    "Please stay on line, I'm nervous."
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
    "The app is not opening, it shows error. What should I do now?",
    "Network is weak here, I can't see the page. Please wait.",
    "Page is stuck on loading, nothing happens.",
    "My UPI app is asking for PIN, I'm not sure.",
    "It says invalid UPI or beneficiary, what now?",
    "I can't paste properly, phone is hanging.",
    "Link not opening, maybe slow net.",
    "It shows server error, please wait.",
    "I'm getting timeout, can you hold?",
    "App is stuck, I will try again."
  ],
  partial_comply_fake_info: [
    "I tried but OTP not received. Should I resend?",
    "I entered the details but it's saying invalid. What next?",
    "OTP not coming, maybe network issue.",
    "I typed but it says wrong, can you resend?",
    "It's asking for PIN, I don't remember now.",
    "I'm getting error after submit, please guide.",
    "I tried once, nothing happened. What now?",
    "It says 'try later', should I wait?",
    "I entered last digits but still failed.",
    "I can't proceed, OTP not received."
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
    "Wait… why PIN on chat? App usually asks that.",
    "Earlier OTP, now PIN? I'm getting confused.",
    "Bank already has my details no? Why again?",
    "This doesn't feel normal… are you sure?",
    "Why link again? I already opened it.",
    "I'm not sure about this step, it's different.",
    "Hmm, you said verify first, now pay? Why?",
    "Why you need OTP here? I don't understand.",
    "This is new to me… I feel uneasy.",
    "I'm scared, this is not how bank does."
  ]
};

export function writeReply(input: WriterInput): string {
  const options = templates[input.nextIntent] || templates.clarify_procedure;
  const available = options.filter((text) => !input.lastReplies.includes(text));
  const pool = available.length > 0 ? available : options;
  const index = Math.floor(Math.random() * pool.length);
  const selected = pool[index];

  if (input.state.anxiety > 0.7 && input.nextIntent === "clarify_procedure") {
    return "I'm feeling nervous, please explain slowly what I should do.";
  }

  return selected;
}

const forbidden = ["scam", "fraud", "honeypot", "ai", "bot", "police complaint", "report"];

function isValidReply(reply: string, lastReplies: string[]): boolean {
  if (!reply) return false;
  if (reply.length > 240) return false;
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

function emotionalStage(turnNumber: number): "early" | "middle" | "late" {
  if (turnNumber <= 2) return "early";
  if (turnNumber <= 6) return "middle";
  return "late";
}

function shouldUseConfusedResistance(input: WriterInput): boolean {
  const stressy = input.stressScore > 0.6;
  const otpAsk = /otp|pin|password|cvv|account|upi/i.test(input.lastScammerMessage);
  if (!stressy || !otpAsk) return false;
  const chance = 0.25;
  return Math.random() < chance;
}

export async function writeReplySmart(
  input: WriterInput,
  persona: Persona,
  summary: string,
  openaiWriter: OpenAIWriter
): Promise<string> {
  const stage = emotionalStage(input.turnNumber);
  const canResist = stage !== "early" && shouldUseConfusedResistance(input);
  const selectedInput: WriterInput = canResist ? { ...input, nextIntent: "confused_resistance" } : input;
  try {
    const reply = await openaiWriter(selectedInput, persona, summary);
    if (isValidReply(reply, input.lastReplies)) return reply;
  } catch (err) {
    // fallback below
  }
  return writeReply(selectedInput);
}
