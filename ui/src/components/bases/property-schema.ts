import type { PropertyDefinition } from "#/api/bases";

interface PropertySchema {
  key: string;
  definition: PropertyDefinition;
}

const BUILT_IN_PROPERTIES: readonly PropertySchema[] = [
  { key: "occurred_at", definition: { type: "datetime" } },
  { key: "attendees", definition: { type: "relation", many: true } },
];

/** Resolve schema defaults for consumers only; never persist them as declarations. */
export function effectiveProperties(
  declarations: readonly PropertySchema[] = [],
): readonly PropertySchema[] {
  return [
    ...declarations,
    ...BUILT_IN_PROPERTIES.filter(
      ({ key }) => !declarations.some((property) => property.key === key),
    ),
  ];
}

export function propertyKey(field: string): string {
  return field.startsWith("prop.") ? field.slice(5) : field;
}

export function builtInFieldLabel(field: string): string {
  switch (propertyKey(field)) {
    case "occurred_at":
      return "Occurred";
    case "attendees":
      return "Attendees";
    default:
      return field;
  }
}
