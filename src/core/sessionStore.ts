import fs from "fs";
import path from "path";
import { ExtractedIntelligence } from "./extractor";
import { GoalFlags, Intent, SessionMode, SessionState, StorySummary } from "./planner";

export type EngagementMetrics = {
  mode: SessionMode;
  totalMessagesExchanged: number;
  agentMessagesSent: number;
  scammerMessagesReceived: number;
  startedAt: string;
  lastMessageAt: string;
};

export type SessionMemory = {
  sessionId: string;
  state: SessionState;
  engagement: EngagementMetrics;
  story: StorySummary;
  extractedIntelligence: ExtractedIntelligence;
  goalFlags: GoalFlags;
  lastIntents: Intent[];
  lastReplies: string[];
  agentNotes: string;
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
  suspiciousKeywords: []
};

const DEFAULT_GOALS: GoalFlags = {
  gotUpiId: false,
  gotPaymentLink: false,
  gotPhoneOrEmail: false,
  gotBankAccountLikeDigits: false,
  gotPhishingUrl: false,
  gotExplicitOtpAsk: false
};

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
      this.sessions.set(session.sessionId, session);
    }
  }

  private saveToFile(): void {
    if (!this.persistFile) return;
    const payload = Array.from(this.sessions.values());
    fs.writeFileSync(this.persistFile, JSON.stringify(payload, null, 2));
  }

  getOrCreate(sessionId: string, timestamp: string): SessionMemory {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const fresh: SessionMemory = {
      sessionId,
      state: { ...DEFAULT_STATE },
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
      agentNotes: ""
    };

    this.sessions.set(sessionId, fresh);
    this.saveToFile();
    return fresh;
  }

  update(session: SessionMemory): void {
    this.sessions.set(session.sessionId, session);
    this.saveToFile();
  }
}
