import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge tailwind classes and class names. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
