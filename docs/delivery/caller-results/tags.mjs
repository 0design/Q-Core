export function normalizeTags(input) {
  const seen = new Set();
  const normalized = [];

  for (const value of input) {
    if (typeof value !== 'string') continue;

    const tag = value.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;

    seen.add(tag);
    normalized.push(tag);
  }

  return normalized;
}
