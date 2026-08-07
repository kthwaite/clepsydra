import GithubSlugger from "github-slugger";
import type { Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
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
  excerptText: string;
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

const mdxParser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

function renderedBlockText(node: Nodes): string {
  if (
    node.type === "code" ||
    node.type === "definition" ||
    node.type === "html" ||
    node.type === "mdxjsEsm" ||
    node.type === "mdxFlowExpression" ||
    node.type === "mdxTextExpression"
  ) {
    return "";
  }

  if (node.type === "paragraph") {
    return toString(node, { includeHtml: false });
  }

  if ("children" in node) {
    return node.children.map(renderedBlockText).filter(Boolean).join(" ");
  }

  return toString(node, { includeHtml: false });
}

export function buildDocsIndex(pages: readonly DocPage[]): readonly DocSearchSection[] {
  const sections: DocSearchSection[] = [];
  const slugger = new GithubSlugger();
  let order = 0;

  for (const page of pages) {
    slugger.reset();

    let heading: string | undefined;
    let headingId: string | undefined;
    let bodyParts: string[] = [];

    const emitSection = () => {
      sections.push({
        page,
        heading,
        headingId,
        text: bodyParts.join(" ").replace(/\s+/g, " ").trim(),
        order,
      });
      order += 1;
      bodyParts = [];
    };

    const tree = mdxParser.parse(page.source) as Root;
    for (const node of tree.children) {
      // MDX parses CommonMark-indented code as a paragraph at its source column.
      if ((node.position?.start.column ?? 1) > 4) {
        continue;
      }

      if (node.type === "heading") {
        if (node.depth === 1) {
          continue;
        }

        emitSection();
        heading = toString(node, { includeHtml: false }).replace(/\s+/g, " ").trim();
        headingId = slugger.slug(heading);
        continue;
      }

      const text = renderedBlockText(node);
      if (text !== "") {
        bodyParts.push(text);
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

  if (
    !tokens.every(
      (token) =>
        page.title.includes(token) ||
        page.description.includes(token) ||
        heading.includes(token) ||
        body.includes(token),
    )
  ) {
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

  let excerptText = section.page.title;
  if (tokens.some((token) => body.includes(token))) {
    excerptText = section.text;
  } else if (tokens.some((token) => page.description.includes(token))) {
    excerptText = section.page.description;
  } else if (tokens.some((token) => heading.includes(token))) {
    excerptText = section.heading ?? "";
  }

  return { section, score, scoreClass, excerptText };
}

function transformedPositions(
  value: string,
  transform: (character: string) => string,
): number[] {
  const positions: number[] = [];
  for (let sourceIndex = 0; sourceIndex < value.length; ) {
    const character = String.fromCodePoint(value.codePointAt(sourceIndex) ?? 0);
    const transformed = transform(character);
    for (let offset = 0; offset < transformed.length; offset += 1) {
      positions.push(sourceIndex);
    }
    sourceIndex += character.length;
  }
  return positions;
}

function normalizedWithPositions(value: string): { normalized: string; positions: number[] } {
  const decomposed = value.normalize("NFKD");
  const decomposedPositions = transformedPositions(value, (character) =>
    character.normalize("NFKD"),
  );
  const folded = decomposed.toLocaleLowerCase();
  const foldedPositions = transformedPositions(decomposed, (character) =>
    character.toLocaleLowerCase(),
  );
  const positions: number[] = [];
  let pendingSeparator: number | undefined;

  for (let foldedIndex = 0; foldedIndex < folded.length; ) {
    const character = String.fromCodePoint(folded.codePointAt(foldedIndex) ?? 0);
    const decomposedIndex = foldedPositions[foldedIndex] ?? foldedIndex;
    const sourceIndex = decomposedPositions[decomposedIndex] ?? 0;

    if (LETTER_OR_NUMBER.test(character)) {
      if (pendingSeparator !== undefined && positions.length > 0) {
        positions.push(pendingSeparator);
      }
      pendingSeparator = undefined;
      for (let offset = 0; offset < character.length; offset += 1) {
        positions.push(sourceIndex);
      }
    } else if (positions.length > 0 && pendingSeparator === undefined) {
      pendingSeparator = sourceIndex;
    }

    foldedIndex += character.length;
  }

  return { normalized: normalize(value), positions };
}

function firstTextMatch(text: string, tokens: readonly string[]): number {
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

function buildExcerpt(text: string, tokens: readonly string[]): string {
  if (text.length <= MAX_EXCERPT_LENGTH) {
    return text;
  }

  const matchIndex = firstTextMatch(text, tokens);
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
    .map(({ section, score, excerptText }) => ({
      page: section.page,
      heading: section.heading,
      headingId: section.headingId,
      excerpt: buildExcerpt(excerptText, tokens),
      score,
    }));
}
