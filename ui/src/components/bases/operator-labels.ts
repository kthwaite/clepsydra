import type { FilterOp } from "#/api/bases";

export const VALUELESS_OPERATORS: Partial<Record<FilterOp, true>> = {
  is_empty: true,
  not_empty: true,
  is_today: true,
  is_this_week: true,
  is_past_week: true,
  is_next_week: true,
  is_this_month: true,
};

export const OPERATOR_LABELS: Record<FilterOp, string> = {
  eq: "is",
  ne: "is not",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  in: "is any of",
  links_to: "links to",
  is_empty: "is empty",
  not_empty: "is not empty",
  is_today: "is today",
  is_this_week: "is this week",
  is_past_week: "is in the past week",
  is_next_week: "is in the next week",
  is_this_month: "is this month",
};
