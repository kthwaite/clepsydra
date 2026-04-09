import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { NavigationModeSelector } from "#/components/NavigationModeSelector";
import { IconButton } from "#/components/ui/icon-button";
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
    return (
      <>
        <SettingsCard
          title="Workspace"
          description="Core workspace preferences and startup behavior will live here."
          trailing={<ComingSoonBadge />}
        />
        <SettingsCard
          title="Defaults"
          description="Default note templates and naming rules will be configurable here."
          trailing={<ComingSoonBadge />}
        />
      </>
    );
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
    return (
      <>
        <SettingsCard
          title="Theme Preferences"
          description="Theme and typography controls will be centralized here."
          trailing={<ComingSoonBadge />}
        />
        <SettingsCard
          title="Density and Scale"
          description="UI density and spacing controls are planned for this section."
          trailing={<ComingSoonBadge />}
        />
      </>
    );
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
    <span className="border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground">
      Coming Soon
    </span>
  );
}
