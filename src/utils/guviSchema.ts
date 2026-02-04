export type EngagementSchema = {
  mode: "SAFE" | "SUSPECT" | "SCAM_CONFIRMED" | "COMPLETE";
  totalMessagesExchanged: number;
  agentMessagesSent: number;
  scammerMessagesReceived: number;
  startedAt: string;
  lastMessageAt: string;
};

export type ExtractedIntelligenceSchema = {
  bankAccounts: string[];
  upiIds: string[];
  phishingLinks: string[];
  phoneNumbers: string[];
  emails: string[];
  suspiciousKeywords: string[];
};

export type GuviSchema = {
  status: "success" | "error";
  sessionId: string;
  scamDetected: boolean;
  scamScore: number;
  stressScore: number;
  engagement: EngagementSchema;
  reply: string;
  extractedIntelligence: ExtractedIntelligenceSchema;
  agentNotes: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeFullSchema(args: Partial<GuviSchema> = {}): GuviSchema {
  const now = nowIso();
  const base: GuviSchema = {
    status: "success",
    sessionId: "tester-session",
    scamDetected: false,
    scamScore: 0,
    stressScore: 0,
    engagement: {
      mode: "SAFE",
      totalMessagesExchanged: 0,
      agentMessagesSent: 0,
      scammerMessagesReceived: 0,
      startedAt: now,
      lastMessageAt: now
    },
    reply: "OK",
    extractedIntelligence: {
      bankAccounts: [],
      upiIds: [],
      phishingLinks: [],
      phoneNumbers: [],
      emails: [],
      suspiciousKeywords: []
    },
    agentNotes: ""
  };

  return {
    ...base,
    ...args,
    engagement: {
      ...base.engagement,
      ...(args.engagement || {})
    },
    extractedIntelligence: {
      ...base.extractedIntelligence,
      ...(args.extractedIntelligence || {})
    }
  };
}
