import { ExtractedIntelligence } from "./extractor";
import { StorySummary } from "./planner";
import { Persona } from "./persona";

type ConversationMessage = { sender: string; text: string; timestamp: string };

export function summarize(
  conversationHistory: ConversationMessage[],
  extracted: ExtractedIntelligence,
  story: StorySummary,
  persona: Persona
): string {
  const claim = story.scammerClaim || "unknown claim";
  const ask = story.scammerAsk || "unknown request";
  const got: string[] = [];

  if (extracted.upiIds.length > 0) got.push("UPI");
  if (extracted.phishingLinks.length > 0) got.push("link");
  if (extracted.phoneNumbers.length > 0 || extracted.emails.length > 0) got.push("contact");

  const lastMsg = conversationHistory.length
    ? conversationHistory[conversationHistory.length - 1].text.slice(0, 80)
    : "";

  const gotLine = got.length > 0 ? `We already got: ${got.join(", ")}.` : "We have no payment details yet.";
  const personaLine = `Persona: ${persona.tone}, ${persona.context}, ${persona.languageStyle}, tech ${persona.techLevel}.`;
  const claimLine = `They claim: ${claim}. They ask for: ${ask}.`;
  const lastLine = lastMsg ? `Last message: ${lastMsg}` : "";

  return [claimLine, gotLine, personaLine, lastLine].filter(Boolean).slice(0, 3).join(" ");
}
