/** Pluralize a string based on a number. */
export function pluralize(n: number, singular: string, plural: string) {
  if (!plural) plural = `${singular}s`;
  return n === 1 ? singular : plural;
}
