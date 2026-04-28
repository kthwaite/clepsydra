import { createContext, type PropsWithChildren, useContext, useMemo, useState } from "react";

type Ctx = {
  progress: number;
  setProgress: (p: number) => void;
};

const ReadingProgressContext = createContext<Ctx | null>(null);

export function ReadingProgressProvider({ children }: PropsWithChildren) {
  const [progress, setProgress] = useState(0);
  const value = useMemo(() => ({ progress, setProgress }), [progress]);
  return (
    <ReadingProgressContext.Provider value={value}>{children}</ReadingProgressContext.Provider>
  );
}

export function useReadingProgress(): Ctx {
  const ctx = useContext(ReadingProgressContext);
  if (!ctx) {
    return { progress: 0, setProgress: () => undefined };
  }
  return ctx;
}
