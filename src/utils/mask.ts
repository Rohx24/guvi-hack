export function maskDigits(value: string, visible: number = 4): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= visible) return value;
  const masked = "*".repeat(digits.length - visible) + digits.slice(-visible);
  return value.replace(digits, masked);
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
