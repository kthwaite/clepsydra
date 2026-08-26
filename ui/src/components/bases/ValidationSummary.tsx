import { AlertTriangle } from "lucide-react";
import type { BaseDiagnostic } from "./BaseDefinitionWorkspace";
import { diagnosticRows } from "./diagnostic-rows";

interface ValidationSummaryProps {
  diagnostics: BaseDiagnostic[];
  focusDiagnostic: (path: string) => void;
}

const sections = ["general", "filter", "properties", "views", "file"] as const;
type DiagnosticSection = (typeof sections)[number];

function sectionFor(path: string | null | undefined): DiagnosticSection {
  if (!path) return "file";
  if (path === "name" || path === "description") return "general";
  if (path === "filter" || path.startsWith("filter.")) return "filter";
  if (path === "properties" || path.startsWith("properties."))
    return "properties";
  if (path === "views" || path.startsWith("views[")) return "views";
  return "file";
}

const sectionLabels: Record<DiagnosticSection, string> = {
  general: "General diagnostics",
  filter: "Filter diagnostics",
  properties: "Property diagnostics",
  views: "View diagnostics",
  file: "File diagnostics",
};

export function ValidationSummary({
  diagnostics,
  focusDiagnostic,
}: ValidationSummaryProps) {
  if (diagnostics.length === 0) return null;

  return (
    <aside
      aria-labelledby="validation-summary-heading"
      className="border border-border bg-card p-4"
    >
      <h2
        id="validation-summary-heading"
        className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-warn"
      >
        <AlertTriangle aria-hidden="true" className="h-4 w-4" />
        Validation
      </h2>
      <div className="mt-3 grid gap-4">
        {sections.map((section) => {
          const entries = diagnostics.filter(
            (diagnostic) => sectionFor(diagnostic.path) === section,
          );
          if (entries.length === 0) return null;
          return (
            <section key={section}>
              <h3 className="font-mono text-xs font-semibold text-foreground">
                {sectionLabels[section]}
              </h3>
              <ul className="mt-1 grid gap-1">
                {diagnosticRows(entries).map(({ diagnostic, key }) => (
                  <li key={key}>
                    {diagnostic.path ? (
                      <button
                        type="button"
                        data-diagnostic-path={diagnostic.path}
                        onClick={() =>
                          focusDiagnostic(diagnostic.path as string)
                        }
                        className={
                          diagnostic.severity === "error"
                            ? "w-full text-left text-sm text-destructive underline decoration-transparent underline-offset-2 hover:decoration-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                            : "w-full text-left text-sm text-warn underline decoration-transparent underline-offset-2 hover:decoration-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                        }
                      >
                        <span>{diagnostic.message}</span>{" "}
                        <span className="font-mono text-xs opacity-80">
                          {diagnostic.path}
                        </span>
                      </button>
                    ) : (
                      <p
                        role={
                          diagnostic.severity === "error" ? "alert" : undefined
                        }
                        className="text-sm text-foreground"
                      >
                        {diagnostic.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
