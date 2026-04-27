export function dimensionNameToSearchTerms(dimensionName: string): string[] {
  const terms: string[] = [];
  const lower = dimensionName.toLowerCase();

  if (lower.includes("todo")) terms.push("TODO");
  if (lower.includes("fixme")) terms.push("FIXME");
  if (lower.includes("test")) terms.push("test");
  if (lower.includes("coverage")) terms.push("coverage");
  if (lower.includes("lint") || lower.includes("eslint")) terms.push("eslint");
  if (lower.includes("error") || lower.includes("bug")) terms.push("error");
  if (lower.includes("doc") || lower.includes("readme")) terms.push("README");

  if (terms.length === 0) {
    const words = dimensionName.split("_").filter((word) => word.length > 2);
    terms.push(...words.slice(0, 2));
  }

  return terms.length > 0 ? terms : [dimensionName];
}

