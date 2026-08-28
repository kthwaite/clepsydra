import type { QueryOutput } from "#/api/bases";

/** True when a row with `id` appears anywhere in a flat or grouped output. */
export function outputContains(output: QueryOutput, id: string): boolean {
  return output.shape === "flat"
    ? output.rows.some((row) => row.id === id)
    : output.groups.some((group) => group.rows.some((row) => row.id === id));
}
