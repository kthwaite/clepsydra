import { useEffect, useState } from "react";
import type { BaseFilter } from "#/api/bases";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
import { FilterSeedMenu } from "./filter-actions";
import { FilterGroupEditor } from "./FilterGroupEditor";

interface MembershipEditorProps {
  value: BaseFilter | undefined;
  properties: DraftProperty[];
  onChange(value: BaseFilter | undefined): void;
  registerFocus: RegisterFocusTarget;
  label?: string;
  diagnostics?: BaseDiagnostic[];
  diagnosticRoot?: string;
}

export function MembershipEditor({
  value,
  properties,
  onChange,
  registerFocus,
  label = "Membership filter",
  diagnostics = [],
  diagnosticRoot = "filter",
}: MembershipEditorProps) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => setDraftValue(value), [value]);

  function commit(next: BaseFilter | undefined) {
    setDraftValue(next);
    onChange(next);
  }

  if (!draftValue) {
    return (
      <div aria-label={label}>
        <div className="border-y border-border py-5">
          <p className="text-sm font-medium text-foreground">All pages</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Add a rule to limit which pages belong to this base.
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <FilterSeedMenu
            triggerLabel="Add rule"
            variant="primary"
            onSeed={commit}
          />
        </div>
      </div>
    );
  }

  return (
    <div aria-label={label}>
      <FilterGroupEditor
        value={draftValue}
        root={draftValue}
        path={[]}
        position={1}
        properties={properties}
        onChange={commit}
        registerFocus={registerFocus}
        diagnostics={diagnostics}
        diagnosticRoot={diagnosticRoot}
      />
      <div
        aria-label="Root membership controls"
        className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3"
      >
        <FilterSeedMenu
          triggerLabel="Membership actions"
          replace
          onSeed={commit}
          clear={{
            label: "Clear membership",
            onAction: () => commit(undefined),
          }}
        />
      </div>
    </div>
  );
}
