import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { components } from "#/api/schema";
import { $api, fetchClient } from "./client";
import { invalidateByPath, queryKeys } from "./keys";

export type AttachmentInfo = components["schemas"]["AttachmentInfo"];

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

export function attachmentUrl(path: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/vault/attachments/${encodedPath}`;
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, "\\$&");
}

export function attachmentMarkdown(attachment: AttachmentInfo): string {
  const label = escapeMarkdownLabel(attachment.name);
  const url = attachmentUrl(attachment.path);
  return IMAGE_EXTENSION.test(attachment.path)
    ? `![${label}](${url})`
    : `[${label}](${url})`;
}

function useInvalidateAttachments() {
  const queryClient = useQueryClient();
  return useCallback(
    () => invalidateByPath(queryClient, queryKeys.attachments.pathPrefix),
    [queryClient],
  );
}

export function useAttachments(enabled = true) {
  return $api.useQuery(
    "get",
    "/api/vault/attachments",
    {},
    { enabled, throwOnError: false },
  );
}

export function useUploadAttachment() {
  const invalidate = useInvalidateAttachments();
  return useMutation({
    mutationFn: async ({
      file,
      path = file.name,
    }: {
      file: File;
      path?: string;
    }) => {
      const body = new FormData();
      body.append("file", file);
      body.append("plaintext_acknowledged", "true");
      const { data, error } = await fetchClient.POST(
        "/api/vault/attachments/{path}",
        {
          params: { path: { path } },
          body: body as unknown as components["schemas"]["AttachmentUploadForm"],
        },
      );
      if (error) throw error;
      if (!data) throw new Error("Attachment upload returned no data.");
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteAttachment() {
  const invalidate = useInvalidateAttachments();
  return $api.useMutation("delete", "/api/vault/attachments/{path}", {
    onSuccess: invalidate,
  });
}
