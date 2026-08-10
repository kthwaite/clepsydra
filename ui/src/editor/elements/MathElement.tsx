import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor, Transforms } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import {
  MathExpression,
  renderMathToHtml,
} from "#/components/MathExpression";
import type {
  InlineMathElement,
  MathBlockElement,
} from "#/editor/types";
import { useMathEditing } from "#/editor/mathEditing";

interface MathSourceEditorProps {
  display: boolean;
  initialTex: string;
  onCommit(tex: string): void;
  onClose(): void;
  onEscapeClose(): void;
  onExit(side: "before" | "after", tex: string): void;
}

function MathSourceEditor({
  display,
  initialTex,
  onCommit,
  onClose,
  onEscapeClose,
  onExit,
}: MathSourceEditorProps) {
  const [draft, setDraft] = useState(initialTex);
  const sourceRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const setSourceRef = useCallback(
    (source: HTMLInputElement | HTMLTextAreaElement | null) => {
      sourceRef.current = source;
    },
    [],
  );
  const descriptionId = useId();
  const valid = useMemo(
    () => renderMathToHtml(draft, display).ok,
    [display, draft],
  );

  useEffect(() => {
    sourceRef.current?.focus();
    sourceRef.current?.select();
  }, []);

  const finish = () => {
    onCommit(draft);
    if (valid) onClose();
  };

  const handleChange = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setDraft(event.currentTarget.value);
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCommit(draft);
      if (valid) onEscapeClose();
      return;
    }

    const source = event.currentTarget;
    const collapsed = source.selectionStart === source.selectionEnd;
    const exitsBefore =
      event.key === "ArrowLeft" && collapsed && source.selectionStart === 0;
    const exitsAfter =
      event.key === "ArrowRight" &&
      collapsed &&
      source.selectionEnd === draft.length;
    if (!exitsBefore && !exitsAfter) return;

    event.preventDefault();
    onExit(exitsBefore ? "before" : "after", draft);
    if (valid) onClose();
  };

  const label = display ? "Edit display math" : "Edit inline math";
  const className = `cl-mono border bg-paper px-1.5 py-0.5 text-ink outline-none focus:border-accent ${
    valid ? "border-border" : "border-destructive"
  } ${display ? "min-h-20 w-full resize-y" : "w-[min(28rem,80vw)] align-baseline"}`;
  const fieldProps = {
    "aria-describedby": valid ? undefined : descriptionId,
    "aria-invalid": valid ? undefined : (true as const),
    "aria-label": label,
    className,
    onBlur: finish,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    value: draft,
  };

  return (
    <>
      {display ? (
        <textarea {...fieldProps} ref={setSourceRef} rows={3} />
      ) : (
        <input {...fieldProps} ref={setSourceRef} type="text" />
      )}
      {!valid && (
        <span id={descriptionId} className="sr-only">
          Invalid TeX source
        </span>
      )}
    </>
  );
}

interface MathElementProps extends RenderElementProps {
  element: InlineMathElement | MathBlockElement;
}

function ActivatableMath({
  children,
  display,
  testId,
  onActivate,
}: {
  children: ReactNode;
  display: boolean;
  testId: string;
  onActivate?: () => void;
}) {
  const Wrapper = display ? "div" : "span";
  if (!onActivate) {
    return <Wrapper data-testid={testId}>{children}</Wrapper>;
  }
  return (
    <Wrapper
      data-testid={testId}
      role="button"
      tabIndex={0}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
    >
      {children}
    </Wrapper>
  );
}

export function MathElement({
  attributes,
  children,
  element,
}: MathElementProps) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useMathEditing();
  const path = ReactEditor.findPath(editor, element);
  const display = element.type === "math-block";
  const active = !readOnly && controller.isActive(path);

  const activate = () => {
    if (readOnly) return;
    Transforms.select(editor, path);
    controller.begin(path);
  };

  const exit = (side: "before" | "after", tex: string) => {
    controller.commit(tex);
    const point =
      side === "before"
        ? Editor.before(editor, path, { voids: true })
        : Editor.after(editor, path, { voids: true });
    if (point) Transforms.select(editor, point);
    queueMicrotask(() => ReactEditor.focus(editor));
  };

  const closeFromEscape = () => {
    controller.close();
    queueMicrotask(() => ReactEditor.focus(editor));
  };

  const sourceOrExpression = active ? (
    <MathSourceEditor
      display={display}
      initialTex={element.tex}
      onCommit={controller.commit}
      onClose={controller.close}
      onEscapeClose={closeFromEscape}
      onExit={exit}
    />
  ) : (
    <ActivatableMath
      display={display}
      testId={element.type}
      onActivate={readOnly ? undefined : activate}
    >
      <MathExpression
        tex={element.tex}
        delimiter={element.delimiter}
        display={display}
      />
    </ActivatableMath>
  );

  if (display) {
    return (
      <div
        {...attributes}
        contentEditable={false}
        className="my-4 min-w-0"
        data-testid={active ? element.type : undefined}
      >
        {sourceOrExpression}
        {children}
      </div>
    );
  }

  return (
    <span
      {...attributes}
      contentEditable={false}
      className="mx-0.5 inline-block max-w-full align-baseline"
      data-testid={active ? element.type : undefined}
    >
      {sourceOrExpression}
      {children}
    </span>
  );
}
