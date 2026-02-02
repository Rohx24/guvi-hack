import { SessionState, StorySummary } from "./planner";

export type WriterInput = {
  nextIntent:
    | "clarify_procedure"
    | "seek_reassurance"
    | "delay_busy"
    | "pretend_technical_issue"
    | "partial_comply_fake_info"
    | "request_link_or_upi"
    | "ask_for_official_id_softly";
  state: SessionState;
  stressScore: number;
  lastScammerMessage: string;
  story: StorySummary;
};

const templates: Record<WriterInput["nextIntent"], string[]> = {
  clarify_procedure: [
    "Sir, I am little confused. Please tell step by step what to do.",
    "I'm not understanding properly, can you explain the process again?"
  ],
  seek_reassurance: [
    "I'm getting worried, is my account safe? Please confirm once.",
    "Please don't block anything, I will do it. Just guide me calmly."
  ],
  delay_busy: [
    "I'm outside right now, give me 10 minutes. Don't close the case please.",
    "I'm in meeting, can I do this after some time?"
  ],
  pretend_technical_issue: [
    "The app is not opening, it shows error. What should I do now?",
    "Network is weak here, I can't see the page. Please wait."
  ],
  partial_comply_fake_info: [
    "I tried but OTP not received. Should I resend?",
    "I entered the details but it's saying invalid. What next?"
  ],
  request_link_or_upi: [
    "Okay, please send the link or UPI ID again. I will check now.",
    "Can you share the exact UPI or payment link? I will try from my side."
  ],
  ask_for_official_id_softly: [
    "Sir, for my record can you share your employee ID or office number?",
    "Just to be sure, please share official reference number."
  ]
};

export function writeReply(input: WriterInput): string {
  const options = templates[input.nextIntent] || templates.clarify_procedure;
  const index = Math.min(options.length - 1, Math.max(0, Math.round(input.stressScore * (options.length - 1))));
  const selected = options[index];

  if (input.state.anxiety > 0.7 && input.nextIntent === "clarify_procedure") {
    return "I'm feeling nervous, please explain slowly what I should do.";
  }

  return selected;
}
