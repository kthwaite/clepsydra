import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useStats } from "#/api/index";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { NavigationModeSelector } from "#/components/NavigationModeSelector";
import { useTheme } from "#/components/ThemeProvider";
import { Badge } from "#/components/ui/badge";
import { IconButton } from "#/components/ui/icon-button";
import { ACCENTS, DENSITIES } from "#/lib/theme";
import { type SettingsSection, useUiStore } from "#/store/ui";

const sections: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "navigation", label: "Navigation" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "advanced", label: "Advanced" },
];

export function SettingsModal() {
  const isOpen = useUiStore((s) => s.isSettingsOpen);
  const activeSection = useUiStore((s) => s.activeSettingsSection);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const setActiveSection = useUiStore((s) => s.setActiveSettingsSection);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4"
    >
      <Modal className="flex h-[min(86vh,720px)] w-full max-w-5xl overflow-hidden border border-border bg-background shadow-lg">
        <Dialog className="flex min-w-0 flex-1 outline-none">
          <aside className="flex w-56 flex-col border-r border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <Heading
                slot="title"
                className="text-sm font-bold uppercase tracking-widest"
              >
                Settings
              </Heading>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-2">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={`mb-1 block w-full border border-transparent px-3 py-2 text-left text-xs uppercase tracking-wider hover:bg-accent ${
                    activeSection === section.id
                      ? "border-border bg-accent font-bold"
                      : "text-muted-foreground"
                  }`}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h3 className="text-sm font-bold uppercase tracking-widest">
                {sections.find((s) => s.id === activeSection)?.label}
              </h3>
              <IconButton
                variant="secondary"
                onPress={closeSettings}
                aria-label="Close settings"
                className="h-auto w-auto p-1"
              >
                <X />
              </IconButton>
            </div>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <SettingsSectionContent section={activeSection} />
            </div>
          </section>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SettingsSectionContent({ section }: { section: SettingsSection }) {
  if (section === "general") {
    return <CorpusPanel />;
  }

  if (section === "navigation") {
    return (
      <>
        <SettingsCard
          title="Tab Opening Mode"
          description="Control what happens when opening a page that is not already open."
          trailing={<NavigationModeSelector />}
        />
        <SettingsCard
          title="Mode Reference"
          description="Smart: focus existing tab or open a new one. New Tab: always open a new tab. Replace: replace the active tab."
        />
      </>
    );
  }

  if (section === "appearance") {
    return <OperatorPreferences />;
  }

  if (section === "editor") {
    return (
      <>
        <SettingsCard
          title="Editing Defaults"
          description="Editor behavior such as autosave and formatting options will be configurable here."
          trailing={<ComingSoonBadge />}
        />
        <SettingsCard
          title="Markdown Tools"
          description="Preview and markdown helper controls are planned for this section."
          trailing={<ComingSoonBadge />}
        />
      </>
    );
  }

  return (
    <>
      <SettingsCard
        title="Diagnostics"
        description="Performance and debugging controls will be available here."
        trailing={<ComingSoonBadge />}
      />
      <SettingsCard
        title="Data Management"
        description="Import/export and maintenance actions are planned for this section."
        trailing={<ComingSoonBadge />}
      />
    </>
  );
}

function OperatorPreferences() {
  const {
    resolvedTheme,
    setMode,
    accent,
    setAccent,
    density,
    setDensity,
    diegetic,
    setDiegetic,
  } = useTheme();

  return (
    <div className="space-y-5">
      <Row label="Mode">
        <Segmented
          value={resolvedTheme}
          options={[
            { id: "dark", label: "Dark" },
            { id: "light", label: "Paper" },
          ]}
          onChange={(v) => setMode(v as "dark" | "light")}
        />
      </Row>

      <Row label="Accent">
        <div className="flex flex-wrap gap-1.5">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAccent(a.id)}
              title={a.label}
              aria-label={a.label}
              className={`flex items-center gap-1.5 border px-2 py-1 ${
                accent === a.id
                  ? "border-accent text-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              <span
                className="inline-block h-[10px] w-[10px]"
                style={{ background: swatch(a.id) }}
              />
              <span className="cl-mono text-[9px] uppercase tracking-[0.1em]">
                {a.id}
              </span>
            </button>
          ))}
        </div>
      </Row>

      <Row label="Density">
        <Segmented
          value={density}
          options={DENSITIES.map((d) => ({ id: d, label: d }))}
          onChange={(v) => setDensity(v as (typeof DENSITIES)[number])}
        />
      </Row>

      <Row label="Diegetic chrome">
        <button
          type="button"
          onClick={() => setDiegetic(!diegetic)}
          className={`cl-mono border px-3 py-1 text-[10px] uppercase tracking-[0.14em] ${
            diegetic
              ? "border-accent bg-accent text-black"
              : "border-border text-muted-foreground"
          }`}
        >
          {diegetic ? "on" : "off"}
        </button>
      </Row>
    </div>
  );
}

function CorpusPanel() {
  const { data: stats } = useStats();
  const rows: [string, ReactNode][] = [
    ["Notes", stats?.pages ?? "—"],
    ["Links, total", stats?.links_total ?? "—"],
    ["Links, resolved", stats?.links_resolved ?? "—"],
    ["Links, unresolved", stats?.links_unresolved ?? "—"],
    ["Tags", stats?.tags ?? "—"],
    ["Attachments", stats?.attachments ?? "—"],
    ["Last collated", formatRelativeTime(stats?.last_indexed_at)],
  ];
  return (
    <div className="border border-border bg-card p-4">
      <h4 className="cl-mono mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        § Corpus
      </h4>
      <div className="cl-mono flex flex-col gap-1 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {k}
            </span>
            <span className="tabular-nums text-foreground">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-4 last:border-b-0">
      <span className="cl-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex w-fit border border-border">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`cl-mono border-r border-border px-3 py-1 text-[10px] uppercase tracking-[0.12em] last:border-r-0 ${
            value === o.id
              ? "bg-accent text-black"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function swatch(id: string): string {
  const map: Record<string, string> = {
    barbican: "#ee7733",
    alert: "#ff3b1f",
    amber: "#ffb84a",
    cyan: "#4cd9ff",
    phosphor: "#5dffa6",
    bone: "#e8e6df",
  };
  return map[id] ?? "#ee7733";
}

function SettingsCard({
  title,
  description,
  trailing,
}: {
  title: string;
  description: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider">
            {title}
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
    </div>
  );
}

function ComingSoonBadge() {
  return (
    <Badge size="sm" className="tracking-widest">
      Coming Soon
    </Badge>
  );
}
