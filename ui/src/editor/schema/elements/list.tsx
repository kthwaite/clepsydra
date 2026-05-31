import type { ElementDescriptor } from "../descriptor";
import type {
  BulletedListElement,
  ListItemElement,
  NumberedListElement,
} from "../types";

export const bulletedListDescriptor: ElementDescriptor<BulletedListElement> = {
  type: "bulleted-list",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};

export const numberedListDescriptor: ElementDescriptor<NumberedListElement> = {
  type: "numbered-list",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};

export const listItemDescriptor: ElementDescriptor<ListItemElement> = {
  type: "list-item",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
