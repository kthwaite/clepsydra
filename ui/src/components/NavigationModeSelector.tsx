import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { type NavigationMode, useWorkspaceStore } from "#/store/workspace";

const modes: { value: NavigationMode; label: string }[] = [
  { value: "smart", label: "Smart" },
  { value: "new", label: "New Tab" },
  { value: "replace", label: "Replace" },
];

export function NavigationModeSelector() {
  const navigationMode = useWorkspaceStore((s) => s.navigationMode);
  const setNavigationMode = useWorkspaceStore((s) => s.setNavigationMode);

  return (
    <RadioGroup
      value={navigationMode}
      onChange={(value) => setNavigationMode(value as NavigationMode)}
      aria-label="Tab opening mode"
    >
      {modes.map((m) => (
        <Radio key={m.value} value={m.value}>
          {m.label}
        </Radio>
      ))}
    </RadioGroup>
  );
}
