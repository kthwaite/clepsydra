import { Tick } from "#/components/codex/Tick";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
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
      className="flex flex-col gap-[18px] self-start rounded-2xl bg-raise px-[22px] pt-5 pb-[22px]"
    >
      <h2 id="validation-summary-heading" className="flex items-center gap-2.5">
        <Tick className="bg-hot" />
        <span className="font-serif text-[20px] italic text-ink">
          Validation
        </span>
        <span className="text-[12.5px] text-mute tabular-nums">
          {diagnostics.length}
        </span>
      </h2>
      {sections.map((section) => {
        const entries = diagnostics.filter(
          (diagnostic) => sectionFor(diagnostic.path) === section,
        );
        if (entries.length === 0) return null;
        return (
          <section key={section} className="flex flex-col gap-1.5 pl-[17px]">
            <h3 className="text-[12.5px] font-normal text-mute">
              {sectionLabels[section]}
            </h3>
            <ul className="flex flex-col gap-2.5">
              {diagnosticRows(entries).map(({ diagnostic, key }) => (
                <li key={key}>
                  {diagnostic.path ? (
                    <button
                      type="button"
                      data-diagnostic-path={diagnostic.path}
                      onClick={() => focusDiagnostic(diagnostic.path as string)}
                      className={`group flex w-full flex-col gap-[3px] rounded-md text-left ${FOCUS_RING_NATIVE}`}
                    >
                      <span className="text-[13.5px] leading-[1.45] text-hot underline decoration-transparent underline-offset-2 group-hover:decoration-current">
                        {diagnostic.message}
                      </span>{" "}
                      <span className="break-all text-[12px] text-mute">
                        {diagnostic.path}
                      </span>
                    </button>
                  ) : (
                    <p
                      role={
                        diagnostic.severity === "error" ? "alert" : undefined
                      }
                      className="text-[13.5px] leading-[1.45] text-ink"
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
    </aside>
  );
}
