import { useEffect, useState } from "react";
import type { BaseFilter } from "#/api/bases";
import { Button } from "#/components/ui/button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
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

  const comparison: BaseFilter = { field: "kind", op: "eq", value: "" };

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
          <Button
            size="sm"
            variant="primary"
            onPress={() => commit(comparison)}
          >
            Add condition
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => commit({ all: [] })}
          >
            Add Match all group
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => commit({ any: [] })}
          >
            Add Match any group
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => commit({ not: comparison })}
          >
            Add Not condition
          </Button>
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
        <Button size="sm" variant="ghost" onPress={() => commit(comparison)}>
          Replace with condition
        </Button>
        <Button size="sm" variant="ghost" onPress={() => commit({ all: [] })}>
          Replace with Match all group
        </Button>
        <Button size="sm" variant="ghost" onPress={() => commit({ any: [] })}>
          Replace with Match any group
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => commit({ not: comparison })}
        >
          Replace with Not condition
        </Button>
        <Button size="sm" variant="ghost" onPress={() => commit(undefined)}>
          Clear membership
        </Button>
      </div>
    </div>
  );
}
