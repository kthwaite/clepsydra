import { X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useEncryptionConfig } from "#/api/encryption";
import { useStats } from "#/api/index";
import { useLocation } from "#/api/location";
import { LocationForm } from "#/components/codex/LocationForm";
import { NavigationModeSelector } from "#/components/NavigationModeSelector";
import { IndexHealthPanel } from "#/components/settings/IndexHealthPanel";
import { useTheme } from "#/components/ThemeProvider";
import { Badge } from "#/components/ui/badge";
import { IconButton } from "#/components/ui/icon-button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { cn } from "#/lib/cn";
import { ACCENTS, DENSITIES } from "#/lib/theme";
import { formatRelativeTime } from "#/lib/time";
import { type SettingsSection, useUiStore } from "#/store/ui";

const sections: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "navigation", label: "Navigation" },
  { id: "appearance", label: "Appearance" },
  { id: "location", label: "Location" },
  { id: "editor", label: "Editor" },
  { id: "advanced", label: "Advanced" },
];

const EncryptionSetupDialog = lazy(() =>
  import("#/components/codex/EncryptionSetupDialog").then((module) => ({
    default: module.EncryptionSetupDialog,
  })),
);

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/35 p-0 md:items-center md:p-4"
    >
      <Modal className="flex h-dvh w-full max-w-none overflow-hidden border border-border bg-background shadow-lg md:h-[min(86vh,720px)] md:max-w-5xl">
        <Dialog className="flex h-full min-w-0 flex-1 outline-none">
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
                  className={cn(
                    "mb-1 block w-full border border-transparent px-3 py-2 text-left text-xs uppercase tracking-wider hover:bg-accent",
                    activeSection === section.id
                      ? "border-border bg-accent font-bold"
                      : "text-muted-foreground",
                  )}
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

  if (section === "location") {
    return <LocationSettings />;
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
      <EncryptionSettings />
      <IndexHealthPanel />
    </>
  );
}

function EncryptionSettings() {
  const config = useEncryptionConfig();
  const [dialogMode, setDialogMode] = useState<
    "setup" | "change-password" | null
  >(null);
  const initialized = config.data?.initialized === true;
  const canChangePassword =
    initialized && Boolean(config.data?.wrapped_identity);

  return (
    <>
      <SettingsCard
        title="Encrypted notes"
        description={
          initialized
            ? `Vault key configured${config.data?.key_id ? ` · ${config.data.key_id}` : ""}. Decrypted identities remain only in the current session.`
            : "Configure an age identity before protecting notes. Exporting the recovery identity is essential: encrypted notes cannot be recovered without it or the password-wrapped copy."
        }
        trailing={
          config.isPending ? (
            <span className="text-xs text-muted-foreground">loading…</span>
          ) : initialized ? (
            canChangePassword ? (
              <button
                type="button"
                className="cl-btn"
                onClick={() => setDialogMode("change-password")}
              >
                Change password
              </button>
            ) : (
              <Badge>recovery identity only</Badge>
            )
          ) : (
            <button
              type="button"
              className="cl-btn cl-btn-hot"
              onClick={() => setDialogMode("setup")}
            >
              Set up encryption
            </button>
          )
        }
      />
      {dialogMode ? (
        <Suspense fallback={null}>
          <EncryptionSetupDialog
            mode={dialogMode}
            onDismiss={() => setDialogMode(null)}
          />
        </Suspense>
      ) : null}
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
        <SegmentedControl
          label="Mode"
          value={resolvedTheme}
          options={[
            { id: "dark", label: "Dark" },
            { id: "light", label: "Paper" },
          ]}
          onChange={(value) => setMode(value as "dark" | "light")}
          className="w-fit gap-0 border border-border"
          itemClassName="cl-mono ml-0 border-0 border-r border-border px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground last:border-r-0 data-[hovered]:bg-transparent data-[hovered]:text-foreground data-[selected]:border-border data-[selected]:bg-accent data-[selected]:font-normal data-[selected]:text-black [&[data-hovered][data-selected]]:text-black"
        />
      </Row>

      <Row label="Accent">
        <SegmentedControl
          label="Accent"
          value={accent}
          options={ACCENTS.map((item) => ({
            id: item.id,
            label: item.label,
            visual: (
              <span
                className="inline-block h-[10px] w-[10px]"
                style={{ background: swatch(item.id) }}
              />
            ),
          }))}
          onChange={(value) =>
            setAccent(value as (typeof ACCENTS)[number]["id"])
          }
          optionsClassName="flex-wrap gap-1.5"
          itemClassName="cl-mono ml-0 flex items-center gap-1.5 border px-2 py-1 text-[9px] uppercase tracking-[0.1em] data-[hovered]:border-border data-[hovered]:bg-transparent data-[hovered]:text-muted-foreground data-[selected]:border-accent data-[selected]:bg-transparent data-[selected]:font-normal data-[selected]:text-foreground [&[data-hovered][data-selected]]:border-accent [&[data-hovered][data-selected]]:text-foreground"
        />
      </Row>

      <Row label="Density">
        <SegmentedControl
          label="Density"
          value={density}
          options={DENSITIES.map((item) => ({
            id: item,
            label: item,
          }))}
          onChange={(value) =>
            setDensity(value as (typeof DENSITIES)[number])
          }
          className="w-fit gap-0 border border-border"
          itemClassName="cl-mono ml-0 border-0 border-r border-border px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground last:border-r-0 data-[hovered]:bg-transparent data-[hovered]:text-foreground data-[selected]:border-border data-[selected]:bg-accent data-[selected]:font-normal data-[selected]:text-black [&[data-hovered][data-selected]]:text-black"
        />
      </Row>

      <Row label="Diegetic chrome">
        <button
          type="button"
          onClick={() => setDiegetic(!diegetic)}
          className={cn(
            "cl-mono border px-3 py-1 text-[10px] uppercase tracking-[0.14em]",
            diegetic
              ? "border-accent bg-accent text-black"
              : "border-border text-muted-foreground",
          )}
        >
          {diegetic ? "on" : "off"}
        </button>
      </Row>
    </div>
  );
}

function LocationSettings() {
  const { data: location } = useLocation();
  const configured = location?.latitude != null && location?.longitude != null;
  return (
    <div className="space-y-4">
      <div className="border border-border bg-card p-4">
        <h4 className="cl-mono mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          § Vault location
        </h4>
        <p className="text-sm text-muted-foreground">
          Sets the coordinates the Atrium sky panel uses for sunrise, sunset,
          and the day-arc. Saved to{" "}
          <code className="cl-mono text-foreground">
            .clepsydra/location.toml
          </code>
          .
        </p>
        <p className="cl-mono mt-2 text-[12px] text-foreground">
          {configured
            ? `${location?.latitude}, ${location?.longitude}${
                location?.label ? ` · ${location.label}` : ""
              }`
            : "Not configured"}
        </p>
      </div>
      <div className="border border-border bg-card">
        <LocationForm initial={location} />
      </div>
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
    ["Pages, orphaned", stats?.orphan_pages ?? "—"],
    ["Pages, isolated", stats?.isolated_pages ?? "—"],
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
