type LogTurnInput = {
  sessionId: string;
  turn: number;
  role: "SCAMMER" | "HONEYPOT";
  text: string;
};

export function logTurn(input: LogTurnInput): void {
  try {
    const sessionId = input.sessionId || "unknown";
    const turn = Number.isFinite(input.turn) && input.turn > 0 ? input.turn : 1;
    const role = input.role || "HONEYPOT";
    const raw = input.text || "";
    const trimmed = raw.length > 500 ? raw.slice(0, 500) : raw;
    console.log(`[HONEYPOT][session=${sessionId}][turn=${turn}][role=${role}]`);
    console.log(trimmed);
    console.log("--------------------------------------------------");
  } catch {
    // swallow logging errors
  }
}
