/**
 * Attribute-equality subset of the Pub/Sub filter language.
 *
 * Supported: `attributes.foo = "bar"` clauses joined by `AND`.
 * Anything else is rejected at create/update time rather than silently ignored.
 */

const ATTRIBUTE_EQUALS = /^attributes\.([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/;

export function parseAttributeFilter(filter: string): Array<{ key: string; value: string }> {
  const trimmed = filter.trim();

  if (trimmed === '') {
    return [];
  }

  const clauses = trimmed
    .split(/\s+AND\s+/i)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0);

  if (clauses.length === 0) {
    return [];
  }

  const parsed: Array<{ key: string; value: string }> = [];

  for (const clause of clauses) {
    const match = clause.match(ATTRIBUTE_EQUALS);

    if (!match) {
      throw new Error(
        `Unsupported Pub/Sub filter "${filter}". Kinglet implements attribute equality only ` +
          `(attributes.<key> = "<value>", joined by AND).`
      );
    }

    parsed.push({ key: match[1] as string, value: match[2] as string });
  }

  return parsed;
}

export function messageMatchesFilter(
  attributes: Record<string, string> | undefined,
  filter: string | null | undefined
): boolean {
  if (filter == null || filter.trim() === '') {
    return true;
  }

  const clauses = parseAttributeFilter(filter);
  const attrs = attributes ?? {};

  return clauses.every(clause => attrs[clause.key] === clause.value);
}
