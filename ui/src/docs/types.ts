import type { MDXComponents } from "mdx/types";
import type { ComponentType } from "react";

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
  keywords: readonly string[];
}

export interface DocPage extends DocMeta {
  groupId: string;
  source: string;
  Component: ComponentType<{ components?: MDXComponents }>;
}

export interface DocGroup {
  id: string;
  label: string;
  pages: readonly DocPage[];
}

export interface DocSearchSection {
  page: DocPage;
  heading?: string;
  headingId?: string;
  text: string;
  order: number;
}

export interface DocSearchResult {
  page: DocPage;
  heading?: string;
  headingId?: string;
  excerpt: string;
  score: number;
}
