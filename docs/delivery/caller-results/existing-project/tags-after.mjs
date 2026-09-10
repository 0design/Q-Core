// Existing project helper; preserve this export.
export const projectLabel = 'existing-project';
export function normalizeTags(input) {
  const seen = new Set();
  return input.filter((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).map((value) => value.trim().toLowerCase());
}
// User uncommitted note: keep this note.
