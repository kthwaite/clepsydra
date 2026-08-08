import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, expectTypeOf, it } from "vitest";
import * as ReadingProgress from "#/components/codex/ReadingProgressContext";

const useSetterOnly =
  "useSetReadingProgress" in ReadingProgress
    ? ReadingProgress.useSetReadingProgress
    : () => ReadingProgress.useReadingProgress().setProgress;

it("updates value consumers without re-rendering setter-only consumers", () => {
  let setProgress: ((progress: number) => void) | undefined;

  function ValueConsumer() {
    const renders = useRef(0);
    renders.current += 1;
    const { progress } = ReadingProgress.useReadingProgress();
    return <output>{`${progress}:${renders.current}`}</output>;
  }

  function SetterConsumer() {
    const renders = useRef(0);
    renders.current += 1;
    setProgress = useSetterOnly();
    return <output data-testid="setter-renders">{renders.current}</output>;
  }

  render(
    <ReadingProgress.ReadingProgressProvider>
      <ValueConsumer />
      <SetterConsumer />
    </ReadingProgress.ReadingProgressProvider>,
  );

  act(() => setProgress?.(0.5));

  expect(screen.getByText("0.5:2")).toBeInTheDocument();
  expect(screen.getByTestId("setter-renders")).toHaveTextContent("1");
});

it("exposes a setter-only hook with the exact action type", () => {
  expect("useSetReadingProgress" in ReadingProgress).toBe(true);
  if ("useSetReadingProgress" in ReadingProgress) {
    expectTypeOf(ReadingProgress.useSetReadingProgress).returns.toEqualTypeOf<
      (progress: number) => void
    >();
  }
});
