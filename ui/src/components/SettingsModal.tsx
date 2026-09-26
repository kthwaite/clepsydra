import { X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useEncryptionConfig } from "#/api/encryption";
import { useStats } from "#/api/index";
import { useLocation } from "#/api/location";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { LocationForm } from "#/components/codex/LocationForm";
import { Section } from "#/components/codex/Section";
import { NavigationModeSelector } from "#/components/NavigationModeSelector";
import { IndexHealthPanel } from "#/components/settings/IndexHealthPanel";
import { OfflinePanel } from "#/components/settings/OfflinePanel";
import { useTheme } from "#/components/ThemeProvider";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { DENSITIES } from "#/lib/theme";
import { formatRelativeTime } from "#/lib/time";
import { type SettingsSection, useUiStore } from "#/store/ui";

const sections: {
  id: SettingsSection;
  label: string;
  description?: string;
}[] = [
  { id: "general", label: "General", description: "The vault at a glance." },
  {
    id: "navigation",
    label: "Navigation",
    description: "What happens when a page opens.",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "How the app looks on this device.",
  },
  {
    id: "location",
    label: "Location",
    description: "Where the Atrium sky is drawn from.",
  },
  { id: "editor", label: "Editor" },
  {
    id: "advanced",
    label: "Advanced",
    description: "Encryption, index health and the offline copy.",
  },
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

  if (!isOpen) return null;
  const active = sections.find((s) => s.id === activeSection);

  return (
    <CodexModalShell
      ariaLabel="Settings"
      onDismiss={closeSettings}
      widthClassName="w-[92%]"
      maxWidthClassName="max-w-[960px]"
      panelClassName="flex max-md:flex-col md:h-[min(86vh,640px)] rounded-[18px]"
    >
      <aside className="flex flex-shrink-0 flex-col gap-4 bg-sink px-4 pt-6 pb-4 md:w-[248px] md:gap-[22px] md:pt-8 md:pb-6">
        <h2 className="px-3.5 font-serif text-[30px] leading-[1.15] text-ink">
          Settings
        </h2>
        <nav
          aria-label="Settings sections"
          className="flex gap-0.5 max-md:-mx-4 max-md:overflow-x-auto max-md:px-4 md:flex-col"
        >
          {sections.map((section) => {
            const current = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "flex h-10 flex-shrink-0 items-center gap-3 rounded-full px-3.5 text-left text-[14.5px] transition-colors",
                  FOCUS_RING_NATIVE,
                  current
                    ? "bg-accent-tint font-medium text-ink"
                    : "text-mute hover:text-ink",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-[5px] w-[5px] flex-shrink-0 rounded-full",
                    current ? "bg-accent" : "bg-transparent",
                  )}
                />
                {section.label}
              </button>
            );
          })}
        </nav>
        <span className="flex-1 max-md:hidden" />
        <p className="px-3.5 text-[12.5px] leading-normal text-mute max-md:hidden">
          Stored in this browser.
          <br />
          Vault settings live in{" "}
          <code className="text-ink-2">.clepsydra/</code>
        </p>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col md:overflow-y-auto">
        <div className="flex items-start gap-4 px-5 pt-6 md:px-10 md:pt-8 md:pl-12">
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="font-serif text-[36px] leading-none tracking-[-0.01em] text-ink md:text-[44px]">
              {active?.label}
            </h3>
            {active?.description ? (
              <p className="text-[14px] text-mute">{active.description}</p>
            ) : null}
          </div>
          <span className="flex-1" />
          <IconButton
            variant="secondary"
            onPress={closeSettings}
            aria-label="Close settings"
            className="h-9 w-9 text-ink-2"
          >
            <X />
          </IconButton>
        </div>
        <div className="flex flex-col gap-12 px-5 pt-10 pb-10 md:px-10 md:pt-14 md:pl-12">
          <SettingsSectionContent section={activeSection} />
        </div>
      </section>
    </CodexModalShell>
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
          title="Tab opening mode"
          description="Control what happens when opening a page that is not already open."
          trailing={<NavigationModeSelector />}
        />
        <SettingsCard
          title="Mode reference"
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
          title="Editing defaults"
          description="Editor behavior such as autosave and formatting options will be configurable here."
          trailing={<ComingSoonBadge />}
        />
        <SettingsCard
          title="Markdown tools"
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
      <OfflinePanel />
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
            <span className="text-[13px] text-mute">Loading…</span>
          ) : initialized ? (
            canChangePassword ? (
              <Button
                variant="secondary"
                onPress={() => setDialogMode("change-password")}
              >
                Change password
              </Button>
            ) : (
              <Badge>Recovery identity only</Badge>
            )
          ) : (
            <Button variant="primary" onPress={() => setDialogMode("setup")}>
              Set up encryption
            </Button>
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

/** Sample row height per density, for the Appearance preview only. */
const PREVIEW_ROW_HEIGHT: Record<(typeof DENSITIES)[number], string> = {
  compact: "h-8",
  default: "h-10",
  spacious: "h-12",
};

const PREVIEW_ROWS = [
  {
    title: "Set theme-color to cobalt",
    code: "TSK-mild-quail",
    dot: "bg-accent",
  },
  { title: "Bases board view", code: "TSK-keen-newt", dot: "bg-faint" },
  {
    title: "Colour rules for Bases",
    code: "TSK-dry-lark",
    dot: "bg-transparent",
  },
] as const;

function OperatorPreferences() {
  const { resolvedTheme, setMode, density, setDensity } = useTheme();

  return (
    <>
      <Section label="Mode" compact headingLevel={4} className="[&_h4]:text-[21px]">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
          <SegmentedControl
            label="Mode"
            value={resolvedTheme}
            options={[
              { id: "light", label: "Bone" },
              { id: "dark", label: "Night" },
            ]}
            onChange={(value) => setMode(value as "dark" | "light")}
            itemClassName={SEGMENT_ITEM}
          />
          <p className="text-[13px] text-mute">
            Bone for daylight, night for the lamp.{" "}
            <kbd className="font-sans text-ink-2">⇧⌘\</kbd> switches anywhere.
          </p>
        </div>
      </Section>

      <Section label="Density" compact headingLevel={4} className="[&_h4]:text-[21px]">
        <div className="flex flex-col gap-[22px]">
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
            itemClassName={cn(SEGMENT_ITEM, "capitalize")}
          />
          <div
            aria-hidden="true"
            data-density-preview={density}
            className="flex w-full max-w-[420px] flex-col rounded-[14px] bg-ground py-1.5"
          >
            {PREVIEW_ROWS.map((row) => (
              <span
                key={row.code}
                className={cn(
                  "flex items-center gap-2.5 px-4 text-[14px] text-ink transition-[height]",
                  PREVIEW_ROW_HEIGHT[density],
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                    row.dot,
                  )}
                />
                <span className="min-w-0 truncate">{row.title}</span>
                <span className="flex-1" />
                <span className="flex-shrink-0 text-[12.5px] text-mute">
                  {row.code}
                </span>
              </span>
            ))}
          </div>
          <p className="text-[13px] text-mute">
            Sets row height and spacing, not type size. Each table's Compact
            switch starts from here.
          </p>
        </div>
      </Section>
    </>
  );
}

/** Mockup segment: 34px pill, 14px label. */
const SEGMENT_ITEM = "h-[34px] px-4 text-[14px]";

function LocationSettings() {
  const { data: location } = useLocation();
  const configured = location?.latitude != null && location?.longitude != null;
  return (
    <Section label="Vault location" compact headingLevel={4} className="[&_h4]:text-[21px]">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="max-w-2xl text-[14px] text-mute">
            Sets the coordinates the Atrium sky panel uses for sunrise, sunset,
            and the day-arc. Saved to{" "}
            <code className="text-[13px] text-ink-2">
              .clepsydra/location.toml
            </code>
            .
          </p>
          <p className="text-[14px] text-ink tabular-nums">
            {configured
              ? `${location?.latitude}, ${location?.longitude}${
                  location?.label ? ` · ${location.label}` : ""
                }`
              : "Not configured"}
          </p>
        </div>
        <LocationForm initial={location} className="p-0" />
      </div>
    </Section>
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
    <Section label="Corpus" compact headingLevel={4} className="[&_h4]:text-[21px]">
      <dl className="flex max-w-[420px] flex-col gap-1.5 text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4">
            <dt className="text-mute">{k}</dt>
            <dd className="text-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
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
    <Section label={title} compact headingLevel={4} className="[&_h4]:text-[21px]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="min-w-0 max-w-2xl flex-1 basis-64 text-[14px] text-mute">
          {description}
        </p>
        {trailing && <div className="flex-shrink-0">{trailing}</div>}
      </div>
    </Section>
  );
}

function ComingSoonBadge() {
  return <Badge size="sm">Coming soon</Badge>;
}
