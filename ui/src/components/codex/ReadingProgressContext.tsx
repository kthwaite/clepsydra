import {
  createContext,
  type PropsWithChildren,
  useContext,
  useState,
} from "react";

type Ctx = {
  progress: number;
  setProgress: (p: number) => void;
};

type SetProgress = (progress: number) => void;

const DEFAULT_SET_PROGRESS: SetProgress = () => undefined;
const ReadingProgressValueContext = createContext(0);
const ReadingProgressActionsContext = createContext<SetProgress>(
  DEFAULT_SET_PROGRESS,
);

export function ReadingProgressProvider({ children }: PropsWithChildren) {
  const [progress, setProgress] = useState(0);
  return (
    <ReadingProgressActionsContext.Provider value={setProgress}>
      <ReadingProgressValueContext.Provider value={progress}>
        {children}
      </ReadingProgressValueContext.Provider>
    </ReadingProgressActionsContext.Provider>
  );
}

export function useReadingProgress(): Ctx {
  return {
    progress: useContext(ReadingProgressValueContext),
    setProgress: useContext(ReadingProgressActionsContext),
  };
}

export function useSetReadingProgress(): SetProgress {
  return useContext(ReadingProgressActionsContext);
}
