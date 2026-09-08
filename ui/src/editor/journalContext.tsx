import { createContext, type ReactNode, useContext } from "react";

/**
 * The calendar date (`YYYY-MM-DD`) of the journal page the editor is showing,
 * or null for every other page. Dated time headings hide their date when it
 * matches this value; the markdown still carries it.
 */
const JournalDateContext = createContext<string | null>(null);

export function JournalDateProvider({
  date,
  children,
}: {
  date: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <JournalDateContext.Provider value={date ?? null}>
      {children}
    </JournalDateContext.Provider>
  );
}

export function useJournalDate(): string | null {
  return useContext(JournalDateContext);
}
