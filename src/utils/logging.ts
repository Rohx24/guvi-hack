import type { IncomingHttpHeaders } from "http";

export function maskDigits(input: string): string {
  return input.replace(/\d{3,}/g, (match) => {
    const keep = match.slice(-2);
    return "*".repeat(Math.max(0, match.length - 2)) + keep;
  });
}

export function maskApiKey(value?: string): string {
  if (!value) return "missing";
  const key = String(value);
  if (key.length <= 4) return "*".repeat(key.length);
  return "*".repeat(key.length - 4) + key.slice(-4);
}

export function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined") continue;
    const lower = key.toLowerCase();
    const str = Array.isArray(value) ? value.join(",") : String(value);
    output[lower] = lower === "x-api-key" ? maskApiKey(str) : str;
  }
  return output;
}

export function safeStringify(value: unknown, maxLen: number): string {
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = maskDigits(text);
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}...(truncated)`;
  }
  return text;
}

export function safeLog(message: string): void {
  try {
    console.info(message);
  } catch {
    // swallow logging errors
  }
}
