import fs from "fs";
import path from "path";
import { ExtractedIntelligence } from "./extractor";
import { EngagementStage, GoalFlags, Intent, SessionMode, SessionState, StorySummary } from "./planner";
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
  branch?: string;
  city?: string;
  employeeId?: string;
  designation?: string;
  managerName?: string;
  callbackNumber?: string;
  referenceId?: string;
  txnAmount?: string;
  txnTime?: string;
  txnMode?: string;
  deviceCity?: string;
  link?: string;
  upi?: string;
  accountHint?: string;

  employeeIds: Set<string>;
  phoneNumbers: Set<string>;
  links: Set<string>;
  upiIds: Set<string>;
  orgNames: Set<string>;
  caseIds: Set<string>;
  tollFreeNumbers: Set<string>;
  senderIds: Set<string>;
  hasLink: boolean;
  hasEmployeeId: boolean;
  hasPhone: boolean;
  hasUpi: boolean;
};

export type SessionMemory = {
  sessionId: string;
  state: SessionState;
  scamDetected: boolean;
  engagementStage: EngagementStage;
  conversationPhase: string;
  level: number;
  usedThrowOffs: number;
  engagement: EngagementMetrics;
  story: StorySummary;
  extractedIntelligence: ExtractedIntelligence;
  persona: Persona;
  goalFlags: GoalFlags;
  lastIntents: Intent[];
  lastReplyTexts: string[];
  agentNotes: string;
  messages: SessionMessage[];
  facts: SessionFacts;
  askedSlots: Set<string>;
  runningSummary: string;
  callbackSent: boolean;
  callbackInFlight?: boolean;
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
  employeeIds: [],
  caseIds: [],
  tollFreeNumbers: [],
  senderIds: []
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
  phoneNumbers: new Set<string>(),
  links: new Set<string>(),
  upiIds: new Set<string>(),
  orgNames: new Set<string>(),
  caseIds: new Set<string>(),
  tollFreeNumbers: new Set<string>(),
  senderIds: new Set<string>(),
  hasLink: false,
  hasEmployeeId: false,
  hasPhone: false,
  hasUpi: false
};

function normalizeFacts(raw: Partial<SessionFacts> | undefined): SessionFacts {
  const toSet = (value: unknown) => {
    if (value instanceof Set) return new Set<string>(Array.from(value as Set<string>));
    if (Array.isArray(value)) return new Set<string>(value as string[]);
    return new Set<string>();
  };
  const employeeIds = toSet(raw?.employeeIds);
  const phoneNumbers = toSet(
    (raw as { phoneNumbers?: unknown } | undefined)?.phoneNumbers ??
      (raw as { phones?: unknown } | undefined)?.phones
  );
  const links = toSet(raw?.links);
  const upiIds = toSet(raw?.upiIds);
  const orgNames = toSet(
    (raw as { orgNames?: unknown } | undefined)?.orgNames ??
      (raw as { orgs?: unknown } | undefined)?.orgs
  );
  const caseIds = toSet((raw as { caseIds?: unknown } | undefined)?.caseIds);
  const tollFreeNumbers = toSet(
    (raw as { tollFreeNumbers?: unknown } | undefined)?.tollFreeNumbers
  );
  const senderIds = toSet((raw as { senderIds?: unknown } | undefined)?.senderIds);
  return {
    branch: raw?.branch,
    city: raw?.city,
    employeeId: raw?.employeeId,
    designation: raw?.designation,
    managerName: raw?.managerName,
    callbackNumber: raw?.callbackNumber,
    referenceId: raw?.referenceId,
    txnAmount: raw?.txnAmount,
    txnTime: raw?.txnTime,
    txnMode: raw?.txnMode,
    deviceCity: raw?.deviceCity,
    link: raw?.link,
    upi: raw?.upi,
    accountHint: raw?.accountHint,
    employeeIds,
    phoneNumbers,
    links,
    upiIds,
    orgNames,
    caseIds,
    tollFreeNumbers,
    senderIds,
    hasLink: Boolean(raw?.hasLink) || links.size > 0,
    hasEmployeeId: Boolean(raw?.hasEmployeeId) || employeeIds.size > 0,
    hasPhone: Boolean(raw?.hasPhone) || phoneNumbers.size > 0,
    hasUpi: Boolean((raw as { hasUpi?: boolean } | undefined)?.hasUpi) || upiIds.size > 0
  };
}

function serializeFacts(facts: SessionFacts): Record<string, unknown> {
  return {
    branch: facts.branch,
    city: facts.city,
    employeeId: facts.employeeId,
    designation: facts.designation,
    managerName: facts.managerName,
    callbackNumber: facts.callbackNumber,
    referenceId: facts.referenceId,
    txnAmount: facts.txnAmount,
    txnTime: facts.txnTime,
    txnMode: facts.txnMode,
    deviceCity: facts.deviceCity,
    link: facts.link,
    upi: facts.upi,
    accountHint: facts.accountHint,
    employeeIds: Array.from(facts.employeeIds),
    phoneNumbers: Array.from(facts.phoneNumbers),
    links: Array.from(facts.links),
    upiIds: Array.from(facts.upiIds),
    orgNames: Array.from(facts.orgNames),
    caseIds: Array.from(facts.caseIds),
    tollFreeNumbers: Array.from(facts.tollFreeNumbers),
    senderIds: Array.from(facts.senderIds),
    hasLink: facts.hasLink,
    hasEmployeeId: facts.hasEmployeeId,
    hasPhone: facts.hasPhone,
    hasUpi: facts.hasUpi
  };
}

function normalizeAskedSlots(raw: unknown): Set<string> {
  if (raw instanceof Set) return raw as Set<string>;
  if (Array.isArray(raw)) {
    return new Set<string>(raw.filter((item) => typeof item === "string") as string[]);
  }
  return new Set<string>();
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
        askedSlots: normalizeAskedSlots(
          (session as unknown as { askedSlots?: unknown }).askedSlots ??
            (session as unknown as { askedQuestions?: unknown }).askedQuestions
        ),
        runningSummary:
          typeof (session as unknown as { runningSummary?: string }).runningSummary === "string"
            ? (session as unknown as { runningSummary: string }).runningSummary
            : "",
        engagementStage:
          (session as unknown as { engagementStage?: EngagementStage }).engagementStage || "CONFUSED",
        conversationPhase:
          typeof (session as unknown as { conversationPhase?: string }).conversationPhase === "string"
            ? (session as unknown as { conversationPhase: string }).conversationPhase
            : "Phase 1",
        level: typeof (session as unknown as { level?: number }).level === "number" ?
          (session as unknown as { level: number }).level : 0,
        usedThrowOffs:
          typeof (session as unknown as { usedThrowOffs?: number }).usedThrowOffs === "number"
            ? (session as unknown as { usedThrowOffs: number }).usedThrowOffs
            : 0,
        lastReplyTexts: Array.isArray((session as unknown as { lastReplyTexts?: string[] }).lastReplyTexts)
          ? (session as unknown as { lastReplyTexts: string[] }).lastReplyTexts
          : Array.isArray((session as unknown as { lastReplies?: string[] }).lastReplies)
          ? (session as unknown as { lastReplies: string[] }).lastReplies
          : [],
        callbackInFlight: Boolean(
          (session as unknown as { callbackInFlight?: boolean }).callbackInFlight
        )
      };
      this.sessions.set(session.sessionId, hydrated);
    }
  }

  private saveToFile(): void {
    if (!this.persistFile) return;
    const payload = Array.from(this.sessions.values()).map((session) => ({
      ...session,
      facts: serializeFacts(session.facts),
      askedSlots: Array.from(session.askedSlots || []),
      lastReplyTexts: session.lastReplyTexts
    }));
    fs.writeFileSync(this.persistFile, JSON.stringify(payload, null, 2));
  }

  getOrCreate(sessionId: string, timestamp: string): SessionMemory {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!existing.persona) existing.persona = createPersona();
      if (!existing.engagementStage) existing.engagementStage = "CONFUSED";
      if (typeof existing.conversationPhase !== "string") existing.conversationPhase = "Phase 1";
      if (typeof existing.level !== "number") existing.level = 0;
      if (typeof existing.usedThrowOffs !== "number") existing.usedThrowOffs = 0;
      if (!existing.goalFlags) existing.goalFlags = { ...DEFAULT_GOALS };
      if (!existing.lastIntents) existing.lastIntents = [];
      if (!existing.lastReplyTexts) existing.lastReplyTexts = [];
      if (typeof existing.scamDetected !== "boolean") existing.scamDetected = false;
      if (typeof existing.callbackSent !== "boolean") existing.callbackSent = false;
      if (typeof existing.callbackInFlight !== "boolean") existing.callbackInFlight = false;
      if (!existing.extractedIntelligence) existing.extractedIntelligence = { ...DEFAULT_EXTRACTED };
      if (!existing.extractedIntelligence.employeeIds) {
        existing.extractedIntelligence.employeeIds = [];
      }
      if (!existing.messages) existing.messages = [];
      existing.facts = normalizeFacts(existing.facts);
      if (!existing.askedSlots) existing.askedSlots = new Set<string>();
      if (typeof existing.runningSummary !== "string") existing.runningSummary = "";
      this.update(existing);
      return existing;
    }

    const fresh: SessionMemory = {
      sessionId,
      state: { ...DEFAULT_STATE },
      scamDetected: false,
      engagementStage: "CONFUSED",
      conversationPhase: "Phase 1",
      level: 0,
      usedThrowOffs: 0,
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
      lastReplyTexts: [],
      agentNotes: "",
      messages: [],
      facts: normalizeFacts(DEFAULT_FACTS),
      askedSlots: new Set<string>(),
      runningSummary: "",
      callbackSent: false,
      callbackInFlight: false
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
      engagementStage: "CONFUSED",
      conversationPhase: "Phase 1",
      level: 0,
      usedThrowOffs: 0,
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
      lastReplyTexts: [],
      agentNotes: "",
      messages: [],
      facts: normalizeFacts(DEFAULT_FACTS),
      askedSlots: new Set<string>(),
      runningSummary: "",
      callbackSent: false,
      callbackInFlight: false
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
