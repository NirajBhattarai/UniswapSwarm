export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}
