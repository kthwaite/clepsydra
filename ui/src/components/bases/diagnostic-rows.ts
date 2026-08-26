interface DiagnosticIdentity {
  path?: string | null;
  severity?: string;
  message: string;
}

export interface DiagnosticRow<Diagnostic> {
  diagnostic: Diagnostic;
  key: string;
}

/**
 * Give repeated diagnostics collision-free occurrence identities. Identical
 * diagnostics are stateless rows, so their order within an identical run is
 * the only observable distinction.
 */
export function diagnosticRows<Diagnostic extends DiagnosticIdentity>(
  diagnostics: readonly Diagnostic[],
): DiagnosticRow<Diagnostic>[] {
  const occurrences = new Map<string, number>();
  return diagnostics.map((diagnostic) => {
    const identity = JSON.stringify([
      diagnostic.path ?? null,
      diagnostic.severity ?? null,
      diagnostic.message,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      diagnostic,
      key: `${identity}:${occurrence}`,
    };
  });
}
