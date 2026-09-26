import type { ErrorComponentProps } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Tick } from "#/components/codex/Tick";
import { OfflineUnavailable } from "#/components/OfflineUnavailable";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { isOfflineUncached } from "#/offline/swPolicy";

type ResponseDetails = {
  status: number | null;
  statusText: string | null;
  url: string | null;
  payload: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getResponseDetails(error: unknown): ResponseDetails | null {
  if (error instanceof Response) {
    return {
      status: error.status,
      statusText: error.statusText || null,
      url: error.url || null,
      payload: null,
    };
  }

  if (!isRecord(error)) {
    return null;
  }

  const status =
    typeof error.status === "number"
      ? error.status
      : typeof error.statusCode === "number"
        ? error.statusCode
        : null;

  const statusText =
    typeof error.statusText === "string"
      ? error.statusText
      : typeof error.statusMessage === "string"
        ? error.statusMessage
        : null;

  const url = typeof error.url === "string" ? error.url : null;
  const payload =
    "data" in error ? error.data : "body" in error ? error.body : null;

  if (
    status === null &&
    statusText === null &&
    url === null &&
    payload === null
  ) {
    return null;
  }

  return {
    status,
    statusText,
    url,
    payload,
  };
}

function getErrorName(error: unknown): string | null {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  if (isRecord(error) && typeof error.name === "string") {
    return error.name;
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unexpected error occurred while rendering this route.";
}

function getStack(error: unknown): string | null {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  if (isRecord(error) && typeof error.stack === "string") {
    return error.stack;
  }
  return null;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return JSON.stringify(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: value.cause,
      },
      null,
      2,
    );
  }

  if (value instanceof Response) {
    return JSON.stringify(
      {
        status: value.status,
        statusText: value.statusText,
        url: value.url,
        redirected: value.redirected,
        type: value.type,
      },
      null,
      2,
    );
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function RouteError({
  error,
  info,
  reset,
}: ErrorComponentProps<unknown>) {
  const [showDetails, setShowDetails] = useState(import.meta.env.DEV);

  const response = getResponseDetails(error);
  const errorName = getErrorName(error);
  const message = getErrorMessage(error);
  const stack = getStack(error);

  if (
    isOfflineUncached(error) ||
    (response && response.status === 503 && isOfflineUncached(response.payload))
  ) {
    return <OfflineUnavailable onRetry={reset} />;
  }

  const metaParts = [
    errorName,
    response && response.status !== null
      ? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 md:px-10 md:py-12">
      <section className="flex flex-col rounded-2xl bg-raise px-6 pt-6 pb-7 md:px-8 md:pt-7 md:pb-[30px]">
        <span className="flex items-center gap-2.5">
          <Tick className="bg-hot" />
          <span className="font-serif text-[19px] italic text-hot">
            Application error
          </span>
        </span>
        <h1 className="mt-3 font-serif text-[36px] leading-[1.05] tracking-[-0.01em] text-ink md:text-[44px]">
          Something went wrong
        </h1>

        <p className="mt-4 text-[17px] leading-[1.6] text-ink-2">{message}</p>

        {metaParts.length > 0 && (
          <p className="mt-1.5 text-[13px] text-mute">
            {metaParts.join(" · ")}
          </p>
        )}

        <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
          <Button variant="primary" onPress={reset}>
            Try again
          </Button>
          <Button
            aria-expanded={showDetails}
            onPress={() => setShowDetails((prev) => !prev)}
          >
            {showDetails ? "Hide technical details" : "Show technical details"}
          </Button>
          <Button onPress={() => window.location.reload()}>Reload app</Button>
        </div>
      </section>

      {showDetails && (
        <div className="flex flex-col gap-[22px] pl-1">
          {response && (
            <DetailSection label="Response">
              <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
                {response.status !== null && (
                  <>
                    <dt className="text-mute">Status</dt>
                    <dd className="m-0 text-ink">{response.status}</dd>
                  </>
                )}
                {response.statusText && (
                  <>
                    <dt className="text-mute">Status text</dt>
                    <dd className="m-0 text-ink">{response.statusText}</dd>
                  </>
                )}
                {response.url && (
                  <>
                    <dt className="text-mute">URL</dt>
                    <dd className="m-0 break-all text-ink">{response.url}</dd>
                  </>
                )}
              </dl>
              {response.payload !== null && (
                <CodeBlock className="mt-2.5">
                  {formatUnknown(response.payload)}
                </CodeBlock>
              )}
            </DetailSection>
          )}

          {stack && (
            <DetailSection label="Stack trace">
              <CodeBlock>{stack}</CodeBlock>
            </DetailSection>
          )}

          {info?.componentStack && (
            <DetailSection label="React component stack">
              <CodeBlock>{info.componentStack}</CodeBlock>
            </DetailSection>
          )}

          <DetailSection label="Raw error">
            <CodeBlock>{formatUnknown(error)}</CodeBlock>
          </DetailSection>
        </div>
      )}
    </div>
  );
}

/** A faint-ticked technical-details block: italic serif eyebrow, body
 *  indented to the eyebrow text. */
function DetailSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <Tick variant="faint" />
        <h2 className="font-serif text-[18px] italic leading-none text-mute">
          {label}
        </h2>
      </div>
      <div className="min-w-0 pl-[17px]">{children}</div>
    </section>
  );
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto rounded-[10px] bg-sink px-4 py-3 text-[12px] leading-[1.6] text-ink-2",
        className,
      )}
    >
      {children}
    </pre>
  );
}
