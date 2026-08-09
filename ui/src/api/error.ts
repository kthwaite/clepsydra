import type { components } from "#/api/schema";

type ApiError = components["schemas"]["ApiError"] & {
  status?: number;
};

export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "string"
  );
}

export function formatApiError(error: unknown, fallback: string): string {
  if (isApiError(error) && error.error) return error.error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function isApiConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}
