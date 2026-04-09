import type { ErrorComponentProps } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";

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

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <section className="border border-destructive bg-background p-5 shadow-md">
        <p className="text-xs font-bold uppercase tracking-widest text-destructive">
          Application error
        </p>
        <h1 className="mt-2 font-heading text-2xl font-bold">
          Something went wrong
        </h1>

        {errorName && (
          <p className="mt-3 text-sm text-muted-foreground">
            Type: {errorName}
          </p>
        )}

        <p className="mt-2 text-sm">{message}</p>

        {response && response.status !== null && (
          <p className="mt-2 text-sm text-muted-foreground">
            HTTP {response.status}
            {response.statusText ? ` ${response.statusText}` : ""}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onPress={reset}>
            Try again
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setShowDetails((prev) => !prev)}
          >
            {showDetails ? "Hide technical details" : "Show technical details"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>
      </section>

      {showDetails && (
        <div className="mt-6 space-y-4">
          {response && (
            <section className="border border-border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                Response
              </h2>
              <dl className="mt-3 space-y-1 text-sm">
                {response.status !== null && (
                  <div>
                    <dt className="inline font-semibold">Status:</dt>{" "}
                    <dd className="inline">{response.status}</dd>
                  </div>
                )}
                {response.statusText && (
                  <div>
                    <dt className="inline font-semibold">Status Text:</dt>{" "}
                    <dd className="inline">{response.statusText}</dd>
                  </div>
                )}
                {response.url && (
                  <div>
                    <dt className="inline font-semibold">URL:</dt>{" "}
                    <dd className="inline break-all">{response.url}</dd>
                  </div>
                )}
              </dl>
              {response.payload !== null && (
                <pre className="mt-3 overflow-x-auto border border-border bg-muted p-3 text-xs">
                  {formatUnknown(response.payload)}
                </pre>
              )}
            </section>
          )}

          {stack && (
            <section className="border border-border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                Stack trace
              </h2>
              <pre className="mt-3 overflow-x-auto border border-border bg-muted p-3 text-xs">
                {stack}
              </pre>
            </section>
          )}

          {info?.componentStack && (
            <section className="border border-border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                React component stack
              </h2>
              <pre className="mt-3 overflow-x-auto border border-border bg-muted p-3 text-xs">
                {info.componentStack}
              </pre>
            </section>
          )}

          <section className="border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Raw error
            </h2>
            <pre className="mt-3 overflow-x-auto border border-border bg-muted p-3 text-xs">
              {formatUnknown(error)}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
