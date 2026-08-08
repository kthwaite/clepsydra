import { useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { BaseMutationResponse, CreateBaseRequest } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import {
  createMinimalDraft,
  isValidBaseSlug,
  slugifyBaseName,
  toWire,
} from "./definition-model";

export interface CreateBaseDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (
    request: CreateBaseRequest,
  ) => Promise<Pick<BaseMutationResponse, "slug">>;
  isPending?: boolean;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Base could not be created.";
}

export function CreateBaseDialog({
  isOpen,
  onClose,
  onCreate,
  isPending = false,
}: CreateBaseDialogProps) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugWasEdited, setSlugWasEdited] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [slugError, setSlugError] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const busy = isPending || submitting;

  useEffect(() => {
    if (!isOpen) {
      setName("");
      setSlug("");
      setSlugWasEdited(false);
      setNameError(undefined);
      setSlugError(undefined);
      setRequestError(undefined);
      setSubmitting(false);
    }
  }, [isOpen]);

  function changeName(nextName: string) {
    setName(nextName);
    setNameError(undefined);
    if (!slugWasEdited) setSlug(slugifyBaseName(nextName));
  }

  function changeSlug(nextSlug: string) {
    setSlugWasEdited(true);
    setSlug(nextSlug);
    setSlugError(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const normalizedName = name.trim();
    const normalizedSlug = slug.trim();
    const nextNameError = normalizedName ? undefined : "Name is required.";
    const nextSlugError = !normalizedSlug
      ? "Slug is required."
      : isValidBaseSlug(normalizedSlug)
        ? undefined
        : "Use only letters, numbers, underscores, and hyphens.";

    setNameError(nextNameError);
    setSlugError(nextSlugError);
    setRequestError(undefined);
    if (nextNameError || nextSlugError) return;

    setSubmitting(true);
    try {
      const definition = toWire(
        createMinimalDraft(normalizedName, undefined, undefined),
      );
      const response = await onCreate({ slug: normalizedSlug, definition });
      onClose();
      // The editor route is added by the following task; preserve its final URL now.
      const destination = {
        to: "/bases/$slug/edit",
        params: { slug: response.slug },
      };
      await navigate(destination as never);
    } catch (error) {
      setRequestError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Create base"
      description="Save a reusable view over pages without moving or owning them."
      isDismissable={!busy}
      footer={
        <>
          <Button variant="secondary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="create-base-form"
            isDisabled={busy}
          >
            {busy ? "Creating…" : "Create base"}
          </Button>
        </>
      }
    >
      <form id="create-base-form" className="space-y-4" onSubmit={submit}>
        <TextField
          label="Name"
          value={name}
          onChange={changeName}
          autoFocus
          isDisabled={busy}
          isInvalid={!!nameError}
          errorMessage={nameError}
          placeholder="Reading Log"
        />
        <TextField
          label="Slug"
          value={slug}
          onChange={changeSlug}
          isDisabled={busy}
          isInvalid={!!slugError}
          errorMessage={slugError}
          description="Vault filename: letters, numbers, underscores, and hyphens."
          placeholder="reading-log"
        />
        <section
          aria-labelledby="base-membership-heading"
          className="border border-border bg-card px-3 py-3"
        >
          <h3
            id="base-membership-heading"
            className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
          >
            Membership
          </h3>
          <p className="mt-2 text-sm text-foreground">All pages</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Default view: All · Table · Title
          </p>
        </section>
        {requestError && (
          <p role="alert" className="text-xs text-destructive">
            {requestError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
