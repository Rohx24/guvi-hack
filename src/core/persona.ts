export type Persona = {
  personaId: string;
  languageStyle: "english" | "hinglish_light";
  techLevel: "low" | "medium";
  context: "office" | "traffic" | "metro" | "home";
  tone: "polite" | "panicky";
  signatureWords: string[];
};

const languageStyles: Persona["languageStyle"][] = ["english", "hinglish_light"];
const techLevels: Persona["techLevel"][] = ["low", "medium"];
const contexts: Persona["context"][] = ["office", "traffic", "metro", "home"];
const tones: Persona["tone"][] = ["polite", "panicky"];

const signatureByTone: Record<Persona["tone"], string[][]> = {
  polite: [["sir"], ["ji"], ["please"], ["sir", "please"]],
  panicky: [["pls"], ["please"], ["bhai"], ["sir"], ["pls", "please"]]
};

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function createPersona(): Persona {
  const tone = pick(tones);
  return {
    personaId: Math.random().toString(36).slice(2, 8),
    languageStyle: pick(languageStyles),
    techLevel: pick(techLevels),
    context: pick(contexts),
    tone,
    signatureWords: pick(signatureByTone[tone])
  };
}
