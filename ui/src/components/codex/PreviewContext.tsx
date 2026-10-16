import { createContext } from "react";

/** The containing preview window; absent in ordinary workspace content. */
export const PreviewContext = createContext<string | undefined>(undefined);

/** Restrictions follow links across portals and are never relaxed by a preview. */
export const PreviewRestrictionsContext = createContext(false);
