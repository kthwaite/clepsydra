import katex from "katex";
import type { KeyboardEvent } from "react";
import { useMemo } from "react";
import { formatMathSource, type MathDelimiter } from "#/lib/markdown/folioMath";

export type MathRenderResult = { ok: true; html: string } | { ok: false };

export interface MathExpressionProps {
  tex: string;
  delimiter: MathDelimiter;
  display: boolean;
  interactive?: boolean;
  onActivate?: () => void;
}

export function renderMathToHtml(
  tex: string,
  display: boolean,
): MathRenderResult {
  try {
    return {
      ok: true,
      html: katex.renderToString(tex, {
        displayMode: display,
        output: "htmlAndMathml",
        trust: false,
        throwOnError: true,
      }),
    };
  } catch {
    return { ok: false };
  }
}

function KatexOutput({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MathExpression({
  tex,
  delimiter,
  display,
  interactive = false,
  onActivate,
}: MathExpressionProps) {
  const rendered = useMemo(
    () => renderMathToHtml(tex, display),
    [display, tex],
  );
  const Wrapper = display ? "div" : "span";
  const canActivate = interactive && onActivate != null;
  const className = [
    "folio-math",
    display && "folio-math--display",
    !rendered.ok && "folio-math--invalid",
    canActivate && "folio-math--interactive",
  ]
    .filter(Boolean)
    .join(" ");

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!canActivate) return;
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    onActivate();
  }

  return (
    <Wrapper
      className={className}
      role={canActivate ? "button" : undefined}
      tabIndex={canActivate ? 0 : undefined}
      onClick={canActivate ? onActivate : undefined}
      onKeyDown={canActivate ? handleKeyDown : undefined}
      aria-invalid={rendered.ok ? undefined : true}
      aria-label={rendered.ok ? undefined : "Invalid mathematical expression"}
    >
      {rendered.ok ? (
        <KatexOutput html={rendered.html} />
      ) : (
        formatMathSource(tex, delimiter)
      )}
    </Wrapper>
  );
}
