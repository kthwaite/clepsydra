import { createContext } from "react";
import type { AttachmentInfo } from "#/api/attachments";

export interface AttachmentGalleryContextValue {
  footer: readonly AttachmentInfo[];
  resolveUrl: (url: string) => string;
  openImage: (url: string) => boolean;
}

export const AttachmentGalleryContext =
  createContext<AttachmentGalleryContextValue | null>(null);
