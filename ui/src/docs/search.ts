import GithubSlugger from "github-slugger";
import type { DocPage, DocSearchResult, DocSearchSection } from "#/docs/types";

const SCORE = {
  exactTitle: 10_000,
  titlePrefix: 5_000,
  titleToken: 1_000,
  headingToken: 300,
  descriptionToken: 100,
  bodyToken: 10,
} as const;

const MAX_EXCERPT_LENGTH = 140;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

type RankedSection = {
  section: DocSearchSection;
  score: number;
  scoreClass: number;
};

type NormalizedPage = {
  title: string;
  description: string;
  metadataOnly: boolean;
};

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^\s{0,3}(?:>|[-+*]|\d+[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
    .trim();
}

function bracketDelta(value: string): number {
  let delta = 0;
  for (const character of value) {
    if (character === "{" || character === "[" || character === "(") {
      delta += 1;
    } else if (character === "}" || character === "]" || character === ")") {
      delta -= 1;
    }
  }
  return delta;
}

export function buildDocsIndex(pages: readonly DocPage[]): readonly DocSearchSection[] {
  const sections: DocSearchSection[] = [];
  const slugger = new GithubSlugger();
  let order = 0;

  for (const page of pages) {
    slugger.reset();

    let heading: string | undefined;
    let headingId: string | undefined;
    let bodyLines: string[] = [];
    let esmDepth = 0;
    let inEsmBlock = false;
    let fenceCharacter: string | undefined;
    let fenceLength = 0;

    const emitSection = () => {
      sections.push({
        page,
        heading,
        headingId,
        text: bodyLines.join(" ").replace(/\s+/g, " ").trim(),
        order,
      });
      order += 1;
      bodyLines = [];
    };

    for (const line of page.source.split(/\r?\n/)) {
      if (inEsmBlock) {
        esmDepth += bracketDelta(line);
        if (esmDepth <= 0) {
          inEsmBlock = false;
        }
        continue;
      }

      const closingFence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (fenceCharacter !== undefined) {
        if (
          closingFence !== undefined &&
          closingFence[0] === fenceCharacter &&
          closingFence.length >= fenceLength
        ) {
          fenceCharacter = undefined;
          fenceLength = 0;
        }
        continue;
      }

      const trimmedLine = line.trim();
      if (/^(?:import|export)\b/.test(trimmedLine)) {
        esmDepth = bracketDelta(line);
        inEsmBlock = esmDepth > 0;
        continue;
      }

      const openingFence = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
      if (openingFence !== undefined) {
        fenceCharacter = openingFence[0];
        fenceLength = openingFence.length;
        continue;
      }

      const headingMatch = line.match(/^\s{0,3}#{2,6}[\t ]+(.+?)(?:[\t ]+#+[\t ]*)?$/);
      if (headingMatch?.[1] !== undefined) {
        emitSection();
        heading = stripMarkdown(headingMatch[1]);
        headingId = slugger.slug(heading);
        continue;
      }

      if (/^\s{0,3}#[\t ]+/.test(line)) {
        continue;
      }

      const bodyLine = stripMarkdown(line);
      if (bodyLine !== "") {
        bodyLines.push(bodyLine);
      }
    }

    emitSection();
  }

  return sections;
}

function rankSection(
  section: DocSearchSection,
  page: NormalizedPage,
  normalizedQuery: string,
  tokens: readonly string[],
): RankedSection | undefined {
  const heading = normalize(section.heading ?? "");
  const body = normalize(section.text);
  const fields = [page.title, page.description, heading, body];

  if (!tokens.every((token) => fields.some((field) => field.includes(token)))) {
    return undefined;
  }

  let score = 0;
  let scoreClass = 0;

  if (page.title === normalizedQuery) {
    score += SCORE.exactTitle;
    scoreClass = SCORE.exactTitle;
  } else if (page.title.startsWith(normalizedQuery)) {
    score += SCORE.titlePrefix;
    scoreClass = SCORE.titlePrefix;
  }

  for (const token of tokens) {
    if (page.title.includes(token)) {
      score += SCORE.titleToken;
      scoreClass = Math.max(scoreClass, SCORE.titleToken);
    }
    if (heading.includes(token)) {
      score += SCORE.headingToken;
      scoreClass = Math.max(scoreClass, SCORE.headingToken);
    }
    if (page.description.includes(token)) {
      score += SCORE.descriptionToken;
      scoreClass = Math.max(scoreClass, SCORE.descriptionToken);
    }
    if (body.includes(token)) {
      score += SCORE.bodyToken;
      scoreClass = Math.max(scoreClass, SCORE.bodyToken);
    }
  }

  return { section, score, scoreClass };
}

function normalizedWithPositions(value: string): { normalized: string; positions: number[] } {
  let normalized = "";
  const positions: number[] = [];
  let pendingSeparator: number | undefined;

  for (let sourceIndex = 0; sourceIndex < value.length; ) {
    const character = String.fromCodePoint(value.codePointAt(sourceIndex) ?? 0);
    const folded = character.normalize("NFKD").toLocaleLowerCase();

    for (const foldedCharacter of folded) {
      if (LETTER_OR_NUMBER.test(foldedCharacter)) {
        if (pendingSeparator !== undefined && normalized !== "") {
          normalized += " ";
          positions.push(pendingSeparator);
        }
        pendingSeparator = undefined;
        normalized += foldedCharacter;
        for (let offset = 0; offset < foldedCharacter.length; offset += 1) {
          positions.push(sourceIndex);
        }
      } else if (normalized !== "" && pendingSeparator === undefined) {
        pendingSeparator = sourceIndex;
      }
    }

    sourceIndex += character.length;
  }

  return { normalized, positions };
}

function firstBodyMatch(text: string, tokens: readonly string[]): number {
  const { normalized, positions } = normalizedWithPositions(text);
  let firstNormalizedIndex = -1;

  for (const token of tokens) {
    const tokenIndex = normalized.indexOf(token);
    if (tokenIndex >= 0 && (firstNormalizedIndex < 0 || tokenIndex < firstNormalizedIndex)) {
      firstNormalizedIndex = tokenIndex;
    }
  }

  return firstNormalizedIndex < 0 ? 0 : (positions[firstNormalizedIndex] ?? 0);
}

function buildExcerpt(section: DocSearchSection, tokens: readonly string[]): string {
  const text = section.text || section.page.description;
  if (text.length <= MAX_EXCERPT_LENGTH) {
    return text;
  }

  const matchIndex = firstBodyMatch(section.text, tokens);
  let start = Math.max(0, matchIndex - 60);
  let end = Math.min(text.length, start + MAX_EXCERPT_LENGTH - 2);

  if (start === 0) {
    end = Math.min(text.length, MAX_EXCERPT_LENGTH - 1);
  } else if (end === text.length) {
    start = Math.max(0, text.length - (MAX_EXCERPT_LENGTH - 1));
  }

  if (start > 0) {
    const nextSpace = text.indexOf(" ", start);
    if (nextSpace >= 0 && nextSpace < matchIndex) {
      start = nextSpace + 1;
    }
  }
  if (end < text.length) {
    const previousSpace = text.lastIndexOf(" ", end);
    if (previousSpace > matchIndex) {
      end = previousSpace;
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function searchDocs(
  index: readonly DocSearchSection[],
  query: string,
): readonly DocSearchResult[] {
  const normalizedQuery = normalize(query);
  if (normalizedQuery === "") {
    return [];
  }

  const tokens = normalizedQuery.split(" ");
  const normalizedPages = new Map<DocPage, NormalizedPage>();

  for (const section of index) {
    if (normalizedPages.has(section.page)) {
      continue;
    }
    const title = normalize(section.page.title);
    const description = normalize(section.page.description);
    normalizedPages.set(section.page, {
      title,
      description,
      metadataOnly: tokens.every(
        (token) => title.includes(token) || description.includes(token),
      ),
    });
  }

  const ranked = index
    .filter((section) => {
      const page = normalizedPages.get(section.page);
      return section.heading === undefined || page?.metadataOnly !== true;
    })
    .map((section) => {
      const page = normalizedPages.get(section.page);
      return page === undefined ? undefined : rankSection(section, page, normalizedQuery, tokens);
    })
    .filter((candidate): candidate is RankedSection => candidate !== undefined);

  const specificClassesByPage = new Map<DocPage, Set<number>>();
  for (const candidate of ranked) {
    if (candidate.section.heading === undefined) {
      continue;
    }
    const classes = specificClassesByPage.get(candidate.section.page) ?? new Set<number>();
    classes.add(candidate.scoreClass);
    specificClassesByPage.set(candidate.section.page, classes);
  }

  return ranked
    .filter(
      (candidate) =>
        candidate.section.heading !== undefined ||
        !specificClassesByPage.get(candidate.section.page)?.has(candidate.scoreClass),
    )
    .sort((left, right) => right.score - left.score || left.section.order - right.section.order)
    .map(({ section, score }) => ({
      page: section.page,
      heading: section.heading,
      headingId: section.headingId,
      excerpt: buildExcerpt(section, tokens),
      score,
    }));
}
