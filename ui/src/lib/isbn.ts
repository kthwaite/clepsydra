const ISBN_SEPARATORS = /[ -]/g;
const ASCII_DIGITS = /^\d+$/;

/** Normalize a valid ISBN-10 or ISBN-13 to canonical ISBN-13 digits. */
export function normalizeIsbn(input: string): string | null {
  const compact = input.replace(ISBN_SEPARATORS, "");
  if (compact.length === 10) return normalizeIsbn10(compact);
  if (compact.length === 13) return normalizeIsbn13(compact);
  return null;
}

function normalizeIsbn10(compact: string): string | null {
  let checksum = 0;
  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index];
    const value =
      index === 9 && (character === "X" || character === "x")
        ? 10
        : digitValue(character);
    if (value === null) return null;
    checksum += value * (10 - index);
  }
  if (checksum % 11 !== 0) return null;

  const stem = `978${compact.slice(0, 9)}`;
  return `${stem}${isbn13CheckDigit(stem)}`;
}

function normalizeIsbn13(compact: string): string | null {
  if (!ASCII_DIGITS.test(compact)) return null;
  if (!compact.startsWith("978") && !compact.startsWith("979")) return null;
  const expected = isbn13CheckDigit(compact.slice(0, 12));
  return expected === Number(compact[12]) ? compact : null;
}

function isbn13CheckDigit(stem: string): number {
  let sum = 0;
  for (let index = 0; index < stem.length; index += 1) {
    sum += Number(stem[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

function digitValue(character: string | undefined): number | null {
  if (!character || character < "0" || character > "9") return null;
  return character.charCodeAt(0) - 48;
}
