export type ExtractedIntelligenceSchema = {
  bankAccounts: string[];
  upiIds: string[];
  phishingLinks: string[];
  phoneNumbers: string[];
  suspiciousKeywords: string[];
};

export type GuviSchema = {
  scamDetected: boolean;
  totalMessagesExchanged: number;
  extractedIntelligence: ExtractedIntelligenceSchema;
  agentNotes: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeFullSchema(args: Partial<GuviSchema> = {}): GuviSchema {
  const now = nowIso();
  const base: GuviSchema = {
    scamDetected: false,
    totalMessagesExchanged: 0,
    extractedIntelligence: {
      bankAccounts: [],
      upiIds: [],
      phishingLinks: [],
      phoneNumbers: [],
      suspiciousKeywords: []
    },
    agentNotes: ""
  };

  return {
    ...base,
    ...args,
    extractedIntelligence: {
      ...base.extractedIntelligence,
      ...(args.extractedIntelligence || {})
    }
  };
}
