import { createContext, useContext } from "react";

export type ConversationDisplayMode = "read" | "edit";

export interface ConversationPresentation {
  mode: ConversationDisplayMode;
  provider: string | null;
}

const DEFAULT_PRESENTATION: ConversationPresentation = {
  mode: "edit",
  provider: null,
};

const ConversationPresentationContext = createContext<ConversationPresentation>(
  DEFAULT_PRESENTATION,
);

export const ConversationPresentationProvider =
  ConversationPresentationContext.Provider;

export function useConversationPresentation(): ConversationPresentation {
  return useContext(ConversationPresentationContext);
}
