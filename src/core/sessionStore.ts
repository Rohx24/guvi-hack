import fs from "fs";
import path from "path";
import { ExtractedIntelligence } from "./extractor";
import { GoalFlags, Intent, SessionMode, SessionState, StorySummary } from "./planner";
import { Persona, createPersona } from "./persona";

export type EngagementMetrics = {
  mode: SessionMode;
  totalMessagesExchanged: number;
  agentMessagesSent: number;
  scammerMessagesReceived: number;
  startedAt: string;
  lastMessageAt: string;
};

export type SessionMessage = {
  sender: "scammer" | "honeypot";
  text: string;
  timestamp: string;
};

export type SessionFacts = {
  employeeIds: Set<string>;
  phones: Set<string>;
  links: Set<string>;
  orgs: Set<string>;
  hasLink: boolean;
  hasEmployeeId: boolean;
  hasPhone: boolean;
  asked: Set<string>;
};

export type SessionMemory = {
  sessionId: string;
  state: SessionState;
  scamDetected: boolean;
  engagement: EngagementMetrics;
  story: StorySummary;
  extractedIntelligence: ExtractedIntelligence;
  persona: Persona;
  goalFlags: GoalFlags;
  lastIntents: Intent[];
  lastReplies: string[];
  agentNotes: string;
  messages: SessionMessage[];
  facts: SessionFacts;
  runningSummary: string;
  callbackSent: boolean;
};

const DEFAULT_STATE: SessionState = {
  anxiety: 0.2,
  confusion: 0.2,
  overwhelm: 0.1,
  trustAuthority: 0.5,
  compliance: 0.3
};

const DEFAULT_STORY: StorySummary = {
  scamType: "",
  scammerClaim: "",
  scammerAsk: ""
};

const DEFAULT_EXTRACTED: ExtractedIntelligence = {
  bankAccounts: [],
  upiIds: [],
  phishingLinks: [],
  phoneNumbers: [],
  emails: [],
  suspiciousKeywords: [],
  employeeIds: []
};

const DEFAULT_GOALS: GoalFlags = {
  gotUpiId: false,
  gotPaymentLink: false,
  gotPhoneOrEmail: false,
  gotBankAccountLikeDigits: false,
  gotPhishingUrl: false,
  gotExplicitOtpAsk: false
};

const DEFAULT_FACTS: SessionFacts = {
  employeeIds: new Set<string>(),
  phones: new Set<string>(),
  links: new Set<string>(),
  orgs: new Set<string>(),
  hasLink: false,
  hasEmployeeId: false,
  hasPhone: false,
  asked: new Set<string>()
};

function normalizeFacts(raw: Partial<SessionFacts> | undefined): SessionFacts {
  const toSet = (value: unknown) =>
    new Set<string>(Array.isArray(value) ? (value as string[]) : []);
  const employeeIds = toSet(raw?.employeeIds);
  const phones = toSet(raw?.phones);
  const links = toSet(raw?.links);
  const orgs = toSet(raw?.orgs);
  const asked = toSet(raw?.asked);
  return {
    employeeIds,
    phones,
    links,
    orgs,
    asked,
    hasLink: Boolean(raw?.hasLink) || links.size > 0,
    hasEmployeeId: Boolean(raw?.hasEmployeeId) || employeeIds.size > 0,
    hasPhone: Boolean(raw?.hasPhone) || phones.size > 0
  };
}

function serializeFacts(facts: SessionFacts): Record<string, unknown> {
  return {
    employeeIds: Array.from(facts.employeeIds),
    phones: Array.from(facts.phones),
    links: Array.from(facts.links),
    orgs: Array.from(facts.orgs),
    asked: Array.from(facts.asked),
    hasLink: facts.hasLink,
    hasEmployeeId: facts.hasEmployeeId,
    hasPhone: facts.hasPhone
  };
}

export class SessionStore {
  private sessions = new Map<string, SessionMemory>();
  private persistFile: string | null;

  constructor() {
    const persistEnabled = process.env.SESSION_PERSIST === "true";
    const file = process.env.SESSIONS_FILE || "sessions.json";
    this.persistFile = persistEnabled ? path.resolve(file) : null;
    if (this.persistFile) {
      this.loadFromFile();
    }
  }

  private loadFromFile(): void {
    if (!this.persistFile) return;
    if (!fs.existsSync(this.persistFile)) return;
    const raw = fs.readFileSync(this.persistFile, "utf-8");
    const parsed = JSON.parse(raw) as SessionMemory[];
    for (const session of parsed) {
      const hydrated: SessionMemory = {
        ...session,
        facts: normalizeFacts((session as unknown as { facts?: SessionFacts }).facts),
        messages: Array.isArray((session as unknown as { messages?: SessionMessage[] }).messages)
          ? (session as unknown as { messages: SessionMessage[] }).messages
          : [],
        runningSummary:
          typeof (session as unknown as { runningSummary?: string }).runningSummary === "string"
            ? (session as unknown as { runningSummary: string }).runningSummary
            : ""
      };
      this.sessions.set(session.sessionId, hydrated);
    }
  }

  private saveToFile(): void {
    if (!this.persistFile) return;
    const payload = Array.from(this.sessions.values()).map((session) => ({
      ...session,
      facts: serializeFacts(session.facts)
    }));
    fs.writeFileSync(this.persistFile, JSON.stringify(payload, null, 2));
  }

  getOrCreate(sessionId: string, timestamp: string): SessionMemory {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!existing.persona) existing.persona = createPersona();
      if (!existing.goalFlags) existing.goalFlags = { ...DEFAULT_GOALS };
      if (!existing.lastIntents) existing.lastIntents = [];
      if (!existing.lastReplies) existing.lastReplies = [];
      if (typeof existing.scamDetected !== "boolean") existing.scamDetected = false;
      if (typeof existing.callbackSent !== "boolean") existing.callbackSent = false;
      if (!existing.extractedIntelligence) existing.extractedIntelligence = { ...DEFAULT_EXTRACTED };
      if (!existing.extractedIntelligence.employeeIds) {
        existing.extractedIntelligence.employeeIds = [];
      }
      if (!existing.messages) existing.messages = [];
      existing.facts = normalizeFacts(existing.facts);
      if (typeof existing.runningSummary !== "string") existing.runningSummary = "";
      this.update(existing);
      return existing;
    }

    const fresh: SessionMemory = {
      sessionId,
      state: { ...DEFAULT_STATE },
      scamDetected: false,
      engagement: {
        mode: "SAFE",
        totalMessagesExchanged: 0,
        agentMessagesSent: 0,
        scammerMessagesReceived: 0,
        startedAt: timestamp,
        lastMessageAt: timestamp
      },
      story: { ...DEFAULT_STORY },
      extractedIntelligence: { ...DEFAULT_EXTRACTED },
      persona: createPersona(),
      goalFlags: { ...DEFAULT_GOALS },
      lastIntents: [],
      lastReplies: [],
      agentNotes: "",
      messages: [],
      facts: normalizeFacts(DEFAULT_FACTS),
      runningSummary: "",
      callbackSent: false
    };

    this.sessions.set(sessionId, fresh);
    this.saveToFile();
    return fresh;
  }

  get(sessionId: string): SessionMemory | undefined {
    return this.sessions.get(sessionId);
  }

  resetSession(session: SessionMemory, timestamp: string): SessionMemory {
    const reset: SessionMemory = {
      ...session,
      state: { ...DEFAULT_STATE },
      scamDetected: false,
      engagement: {
        mode: "SAFE",
        totalMessagesExchanged: 0,
        agentMessagesSent: 0,
        scammerMessagesReceived: 0,
        startedAt: timestamp,
        lastMessageAt: timestamp
      },
      story: { ...DEFAULT_STORY },
      extractedIntelligence: { ...DEFAULT_EXTRACTED },
      goalFlags: { ...DEFAULT_GOALS },
      lastIntents: [],
      lastReplies: [],
      agentNotes: "",
      messages: [],
      facts: normalizeFacts(DEFAULT_FACTS),
      runningSummary: "",
      callbackSent: false
    };
    this.sessions.set(session.sessionId, reset);
    this.saveToFile();
    return reset;
  }

  update(session: SessionMemory): void {
    this.sessions.set(session.sessionId, session);
    this.saveToFile();
  }
}
