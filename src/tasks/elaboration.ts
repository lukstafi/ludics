const ELABORATED_FIELD_RE = /^elaborated:\s*(.+)$/m;

export function isElaborated(content: string): boolean {
  const elaboratedMatch = content.match(ELABORATED_FIELD_RE);
  if (!elaboratedMatch) return false;

  const normalized = elaboratedMatch[1]!
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();

  if (!normalized || normalized === "false" || normalized === "null") {
    return false;
  }

  return true;
}
