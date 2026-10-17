import { X } from "lucide-react";
import type {
  BaseColorRule,
  BaseMetric,
  PropertyType,
  RowColor,
} from "#/api/bases";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import { BaseFilterEditor } from "./BaseFilterEditor";
import {
  type AggregateFunction,
  aggregateFunctions,
  type DraftProperty,
  type DraftView,
  moveItem,
} from "./definition-model";
import { emptyComparison } from "./filter-actions";
import { MoveButtons, useIdentifiedRows } from "./ordered-list";
import { builtInFieldLabel } from "./property-schema";

const COLORS: readonly RowColor[] = [
  "sepia",
  "verdigris",
  "slate",
  "madder",
  "ochre",
  "indigo",
];
const EMPTY_RULES: BaseColorRule[] = [];
const EMPTY_METRICS: BaseMetric[] = [];
const controlClass = cn(
  "mt-1.5 block h-10 w-full rounded-full bg-sink px-4 text-[14px] text-ink",
  FOCUS_RING_NATIVE,
);

interface Props {
  view: DraftView;
  viewPath: string;
  properties: DraftProperty[];
  fields: readonly {
    key: string;
    type: PropertyType | "system-multi" | "word_count" | undefined;
  }[];
  functions: readonly AggregateFunction[];
  diagnostics: BaseDiagnostic[];
  registerFocus: RegisterFocusTarget;
  onChange(view: DraftView): void;
  onAnnounceMove(message: string): void;
}

export function ViewPresentationEditor({
  view,
  viewPath,
  properties,
  fields,
  functions,
  diagnostics,
  registerFocus,
  onChange,
  onAnnounceMove,
}: Props) {
  const rules = view.color_rules ?? EMPTY_RULES;
  const metrics = view.metrics ?? EMPTY_METRICS;
  const ruleRows = useIdentifiedRows(rules, "colour-rule");
  const metricRows = useIdentifiedRows(metrics, "metric");
  function replaceRule(index: number, rule: BaseColorRule) {
    onChange({
      ...view,
      color_rules: rules.map((item, position) =>
        position === index ? rule : item,
      ),
    });
  }
  function replaceMetric(index: number, metric: BaseMetric) {
    onChange({
      ...view,
      metrics: metrics.map((item, position) =>
        position === index ? metric : item,
      ),
    });
  }
  function move(kind: "colour rule" | "metric", from: number, to: number) {
    if (kind === "colour rule") {
      ruleRows.setRows(moveItem(ruleRows.rows, from, to));
      onChange({ ...view, color_rules: moveItem(rules, from, to) });
    } else {
      metricRows.setRows(moveItem(metricRows.rows, from, to));
      onChange({ ...view, metrics: moveItem(metrics, from, to) });
    }
    onAnnounceMove(
      `Moved ${kind} ${from + 1} to position ${to + 1} of ${kind === "colour rule" ? rules.length : metrics.length}.`,
    );
  }
  return (
    <>
      <section
        aria-labelledby={`${view.id}-colours`}
        className="flex min-w-0 flex-col gap-3"
      >
        <h4
          id={`${view.id}-colours`}
          className="font-serif text-[19px] italic text-ink"
        >
          Row colours
        </h4>
        <p className="text-[13px] text-mute">
          First matching rule wins. Add a condition before saving. Colour is a
          visual cue, not a replacement for the row’s values.
        </p>
        <ol aria-label="Colour rules" className="flex flex-col gap-4">
          {ruleRows.rows.map(({ id, value: rule }, index) => (
            <li key={id} className="min-w-0 rounded-xl bg-raise p-3">
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <Select
                  label={`Colour for rule ${index + 1}`}
                  value={rule.color}
                  triggerRef={(element) => {
                    registerFocus(`${viewPath}.color_rules[${index}]`, element);
                    registerFocus(
                      `${viewPath}.color_rules[${index}].color`,
                      element,
                    );
                  }}
                  onChange={(key) => {
                    const color = COLORS.find((candidate) => candidate === key);
                    if (color) replaceRule(index, { ...rule, color });
                  }}
                >
                  {COLORS.map((color) => (
                    <SelectItem key={color} id={color}>
                      {color[0].toUpperCase() + color.slice(1)}
                    </SelectItem>
                  ))}
                </Select>
                <span className="text-[13px] text-mute">
                  Priority {index + 1}
                </span>
                <MoveButtons
                  label={`colour rule ${index + 1}`}
                  index={index}
                  count={rules.length}
                  onMove={(from, to) => move("colour rule", from, to)}
                />
                <IconButton
                  aria-label={`Remove colour rule ${index + 1}`}
                  onPress={() =>
                    onChange({
                      ...view,
                      color_rules: rules.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  <X />
                </IconButton>
              </div>
              <BaseFilterEditor
                value={rule.filter}
                properties={properties}
                diagnostics={diagnostics}
                diagnosticRoot={`${viewPath}.color_rules[${index}].filter`}
                registerFocus={registerFocus}
                label={`Conditions for colour rule ${index + 1}`}
                onChange={(filter) =>
                  filter === undefined
                    ? onChange({
                        ...view,
                        color_rules: rules.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    : replaceRule(index, { ...rule, filter })
                }
              />
            </li>
          ))}
        </ol>
        <Button
          size="sm"
          variant="secondary"
          onPress={() =>
            onChange({
              ...view,
              color_rules: [
                ...rules,
                { color: "sepia", filter: emptyComparison() },
              ],
            })
          }
        >
          Add colour rule
        </Button>
      </section>
      <section
        aria-labelledby={`${view.id}-metrics`}
        className="flex min-w-0 flex-col gap-3"
      >
        <h4
          id={`${view.id}-metrics`}
          className="font-serif text-[19px] italic text-ink"
        >
          Metrics
        </h4>
        <p className="text-[13px] text-mute">
          Values cover the entire filtered view, not just loaded rows. Optional
          targets show numeric progress.
        </p>
        <ol aria-label="Metrics" className="flex flex-col gap-4">
          {metricRows.rows.map(({ id, value: metric }, index) => {
            const path = `${viewPath}.metrics[${index}]`;
            const eligible = fields.filter(({ type }) =>
              aggregateFunctions(type).includes(metric.fn),
            );
            const targetErrors = diagnostics.filter(
              (diagnostic) => diagnostic.path === `${path}.target`,
            );
            return (
              <li key={id} className="min-w-0 rounded-xl bg-raise p-3">
                <div className="grid items-end gap-3 sm:grid-cols-2">
                  <Select
                    label={`Metric function ${index + 1}`}
                    value={metric.fn}
                    triggerRef={(element) => {
                      registerFocus(path, element);
                      registerFocus(`${path}.fn`, element);
                    }}
                    onChange={(key) => {
                      const fn = functions.find(
                        (candidate) => candidate === key,
                      );
                      if (!fn) return;
                      const available = fields.filter(({ type }) =>
                        aggregateFunctions(type).includes(fn),
                      );
                      const field =
                        fn === "count"
                          ? undefined
                          : (available.find(
                              (candidate) => candidate.key === metric.field,
                            )?.key ?? available[0]?.key);
                      replaceMetric(index, { ...metric, fn, field });
                    }}
                  >
                    {functions.map((fn) => (
                      <SelectItem key={fn} id={fn}>
                        {fn}
                      </SelectItem>
                    ))}
                  </Select>
                  {metric.fn !== "count" ? (
                    <Select
                      label={`Metric field ${index + 1}`}
                      value={metric.field ?? ""}
                      triggerRef={(element) =>
                        registerFocus(`${path}.field`, element)
                      }
                      onChange={(key) => {
                        if (key != null)
                          replaceMetric(index, {
                            ...metric,
                            field: String(key),
                          });
                      }}
                    >
                      {eligible.map(({ key }) => (
                        <SelectItem key={key} id={key}>
                          {builtInFieldLabel(key)}
                        </SelectItem>
                      ))}
                    </Select>
                  ) : null}
                  <label className="text-[12.5px] text-mute">
                    Metric label {index + 1}
                    <input
                      className={controlClass}
                      value={metric.label ?? ""}
                      placeholder="Optional label"
                      ref={(element) => registerFocus(`${path}.label`, element)}
                      onChange={(event) =>
                        replaceMetric(index, {
                          ...metric,
                          label: event.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <label className="text-[12.5px] text-mute">
                    Metric target {index + 1}
                    <input
                      type="number"
                      step="any"
                      className={controlClass}
                      value={metric.target ?? ""}
                      placeholder="Optional numeric target"
                      ref={(element) =>
                        registerFocus(`${path}.target`, element)
                      }
                      aria-invalid={
                        targetErrors.some(
                          (diagnostic) => diagnostic.severity === "error",
                        ) || undefined
                      }
                      aria-describedby={
                        targetErrors.length ? `${id}-target-error` : undefined
                      }
                      onChange={(event) =>
                        replaceMetric(index, {
                          ...metric,
                          target:
                            event.target.value === ""
                              ? undefined
                              : event.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                </div>
                {targetErrors.length ? (
                  <p
                    id={`${id}-target-error`}
                    className="mt-2 text-[13px] text-hot"
                  >
                    {targetErrors
                      .map((diagnostic) => diagnostic.message)
                      .join(" ")}
                  </p>
                ) : null}
                <div className="mt-2 flex justify-end">
                  <MoveButtons
                    label={`metric ${index + 1}`}
                    index={index}
                    count={metrics.length}
                    onMove={(from, to) => move("metric", from, to)}
                  />
                  <IconButton
                    aria-label={`Remove metric ${index + 1}`}
                    onPress={() =>
                      onChange({
                        ...view,
                        metrics: metrics.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    <X />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ol>
        <Button
          size="sm"
          variant="secondary"
          onPress={() =>
            onChange({ ...view, metrics: [...metrics, { fn: "count" }] })
          }
        >
          Add metric
        </Button>
      </section>
    </>
  );
}
