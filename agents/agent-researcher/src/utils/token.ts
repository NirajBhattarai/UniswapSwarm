export function dedupeTokenInputs(tokens: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const token of tokens) {
    const key = token.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}
