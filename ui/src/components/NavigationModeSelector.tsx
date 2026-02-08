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
    <select
      value={navigationMode}
      onChange={(e) => setNavigationMode(e.target.value as NavigationMode)}
      className="border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
    >
      {modes.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
