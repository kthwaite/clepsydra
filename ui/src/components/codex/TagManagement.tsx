import { useState } from "react";
import { formatApiError } from "#/api/error";
import { useTags } from "#/api/index";
import {
  type TagRenamePreview,
  useApplyTagRename,
  usePreviewTagRename,
} from "#/api/tag-management";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";

export function TagManagementButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
        Manage tags
      </Button>
      {open && <TagManagementDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function TagManagementDialog({ onClose }: { onClose: () => void }) {
  const tags = useTags();
  const previewMutation = usePreviewTagRename();
  const applyMutation = useApplyTagRename();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<TagRenamePreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const busy = previewMutation.isPending || applyMutation.isPending;
  const matchingTags = (tags.data ?? []).filter(({ tag }) =>
    tag.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  function clearPreview() {
    setPreview(null);
    setAcknowledged(false);
    setError(null);
  }

  async function makePreview() {
    if (!source) return;
    clearPreview();
    setSuccess(null);
    try {
      setPreview(await previewMutation.mutateAsync({ source, target }));
    } catch (cause) {
      setError(formatApiError(cause, "Could not preview this rename."));
    }
  }

  async function apply() {
    if (!preview) return;
    setError(null);
    try {
      const result = await applyMutation.mutateAsync({
        source: preview.source,
        target: preview.target,
        expected_fingerprint: preview.fingerprint,
        acknowledge_merge: acknowledged,
      });
      setSuccess(
        `Renamed #${preview.source} to #${preview.target} on ${result.updated_count} ${result.updated_count === 1 ? "page" : "pages"}.`,
      );
      setSource(null);
      setTarget("");
      setQuery("");
      clearPreview();
    } catch (cause) {
      clearPreview();
      setError(
        formatApiError(cause, "Rename failed. Preview again before retrying."),
      );
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      isDismissable={!busy}
      isCloseDisabled={busy}
      title="Manage tags"
      description="Browse page tags and safely rename an exact editable tag."
      size="full"
    >
      <div className="flex flex-col gap-5">
        {success && (
          <p role="status" className="text-accent">
            {success}
          </p>
        )}
        <TextField label="Search tags" value={query} onChange={setQuery} />
        {tags.error ? (
          <div role="alert" className="text-hot">
            {formatApiError(tags.error, "Tags could not be loaded.")}
            <Button
              variant="ghost"
              onPress={() => {
                void tags.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : tags.isPending ? (
          <p>Loading tags…</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-xl bg-sink p-3">
            <table aria-label="Tags" className="w-full text-left text-sm">
              <thead className="text-mute">
                <tr>
                  <th scope="col" className="p-2">
                    Tag
                  </th>
                  <th scope="col" className="p-2">
                    Total
                  </th>
                  <th scope="col" className="p-2">
                    Editable
                  </th>
                  <th scope="col" className="p-2">
                    Computed
                  </th>
                </tr>
              </thead>
              <tbody>
                {matchingTags.map(({ tag, count, computed_count }) => (
                  <tr key={tag}>
                    <th scope="row" className="p-2 font-normal">
                      <Button
                        variant={source === tag ? "secondary" : "ghost"}
                        size="sm"
                        aria-label={`Rename #${tag}`}
                        isDisabled={busy || count === computed_count}
                        onPress={() => {
                          setSource(tag);
                          setTarget("");
                          setSuccess(null);
                          clearPreview();
                        }}
                      >
                        #{tag}
                      </Button>
                    </th>
                    <td className="p-2 tabular-nums">{count}</td>
                    <td className="p-2 tabular-nums">
                      {count - computed_count}
                    </td>
                    <td className="p-2 tabular-nums">{computed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {matchingTags.length === 0 && (
              <p className="p-2 text-mute">No matching tags.</p>
            )}
          </div>
        )}
        <p className="text-sm text-mute">
          Only exact editable frontmatter tags change. Descendant tags, computed
          kind tags, and saved Base or embed filters stay unchanged; filter
          membership may change. Read-only page bodies and encrypted content
          stay untouched.
        </p>
        {source && (
          <section aria-label="Rename tag" className="flex flex-col gap-4">
            <h2 className="text-lg">Rename #{source}</h2>
            <TextField
              label="New tag name"
              value={target}
              isDisabled={busy}
              onChange={(value) => {
                setTarget(value);
                clearPreview();
              }}
              description="Enter the tag without #. Only this exact tag is renamed, not its descendants."
            />
            <div>
              <Button
                variant="secondary"
                isDisabled={
                  busy ||
                  !target ||
                  target.toLowerCase() === source.toLowerCase()
                }
                onPress={() => {
                  void makePreview();
                }}
              >
                {previewMutation.isPending
                  ? "Inspecting pages…"
                  : "Preview rename"}
              </Button>
            </div>
            {preview && (
              <div className="flex flex-col gap-4 rounded-xl bg-sink p-4">
                <p>
                  {preview.affected_count} editable{" "}
                  {preview.affected_count === 1 ? "page" : "pages"} affected;{" "}
                  {preview.computed_count} computed{" "}
                  {preview.computed_count === 1 ? "page" : "pages"} unchanged.
                </p>
                <ul
                  aria-label="Affected pages"
                  className="max-h-52 space-y-2 overflow-auto pl-5"
                >
                  {preview.pages.map((page) => (
                    <li key={page.path}>
                      <span className="font-medium">{page.title}</span>
                      <span className="block text-sm text-mute">
                        {page.path}
                      </span>
                    </li>
                  ))}
                </ul>
                {preview.conflicts.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-xl bg-raise p-3 text-hot"
                  >
                    <p>
                      No pages will change until these conflicts are resolved:
                    </p>
                    <ul className="mt-2 space-y-2 pl-5">
                      {preview.conflicts.map((conflict) => (
                        <li key={`${conflict.path}:${conflict.reason}`}>
                          {conflict.path ? `${conflict.path}: ` : ""}
                          {conflict.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.target_exists && (
                  <Checkbox
                    isSelected={acknowledged}
                    onChange={setAcknowledged}
                    isDisabled={busy}
                  >
                    I understand that #{preview.target} already exists and want
                    to merge these tags, removing duplicate target tags on each
                    page.
                  </Checkbox>
                )}
                <div>
                  <Button
                    variant="primary"
                    isDisabled={
                      busy ||
                      preview.conflicts.length > 0 ||
                      preview.affected_count === 0 ||
                      (preview.target_exists && !acknowledged)
                    }
                    onPress={() => {
                      void apply();
                    }}
                  >
                    {applyMutation.isPending ? "Renaming…" : "Apply rename"}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="text-hot">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
