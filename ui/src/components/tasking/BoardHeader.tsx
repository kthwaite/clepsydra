import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { Spark } from "#/components/ui/spark";
import { cn } from "#/lib/cn";
import { pad2 } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import { HealthDot, healthColor, MODES, PRI_ORDER } from "./board-constants";
import { isFilterActive } from "./board-filter";

// ── mode glyphs ──────────────────────────────────────────────────────────────

/**
 * Tiny CSS-grid glyph rendered as <i> squares, matching styles-board.css .gl.*
 * cards:    2-col × 2-row grid (4 squares)
 * rows:     3 horizontal bars (full-width, thin height)
 * sprint:   3-col × 1-row grid (3 squares side by side)
 * tl:       3 bars of variable width (timeline stagger)
 */
function ModeGlyph({ gl }: { gl: string }) {
  if (gl === "cards") {
    return (
      <span
        className="inline-grid gap-[1px]"
        style={{
          width: 12,
          height: 10,
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
        }}
      >
        {[0, 1, 2, 3].map((k) => (
          <i
            key={k}
            className="block"
            style={{ background: "currentColor", opacity: 0.85 }}
          />
        ))}
      </span>
    );
  }
  if (gl === "rows") {
    return (
      <span
        className="inline-grid gap-[1px]"
        style={{
          width: 12,
          height: 10,
          gridTemplateColumns: "1fr",
          gridTemplateRows: "1fr 1fr 1fr",
        }}
      >
        {[0, 1, 2].map((k) => (
          <i
            key={k}
            className="block"
            style={{ background: "currentColor", opacity: 0.85, height: 2 }}
          />
        ))}
      </span>
    );
  }
  if (gl === "sprint") {
    return (
      <span
        className="inline-grid gap-[1px]"
        style={{
          width: 12,
          height: 10,
          gridTemplateColumns: "1fr 1fr 1fr",
          gridTemplateRows: "1fr",
        }}
      >
        {[0, 1, 2].map((k) => (
          <i
            key={k}
            className="block"
            style={{ background: "currentColor", opacity: 0.85 }}
          />
        ))}
      </span>
    );
  }
  // tl — 3 variable-width horizontal bars
  return (
    <span
      className="inline-grid"
      style={{
        width: 12,
        height: 10,
        gridTemplateColumns: "1fr",
        gridTemplateRows: "1fr 1fr 1fr",
        gap: 1,
      }}
    >
      <i
        style={{
          display: "block",
          background: "currentColor",
          opacity: 0.85,
          height: 2,
          width: "72%",
        }}
      />
      <i
        style={{
          display: "block",
          background: "currentColor",
          opacity: 0.85,
          height: 2,
          width: "48%",
          marginLeft: "38%",
        }}
      />
      <i
        style={{
          display: "block",
          background: "currentColor",
          opacity: 0.85,
          height: 2,
          width: "60%",
          marginLeft: "14%",
        }}
      />
    </span>
  );
}

// ── BoardHeader ──────────────────────────────────────────────────────────────

interface BoardHeaderProps {
  operations: BoardOperation[];
  cycles: BoardCycle[];
  /** Op-filtered tasks (already filtered by opFilter in TaskingScreen). */
  tasks: BoardTask[];
  /** The active operation object when a single op is selected, else null. */
  activeOp: BoardOperation | null;
  /** Task count after text/priority/hold filtering (the `tasks` prop's length). */
  filteredCount: number;
  /** Task count after op-scoping but before text/priority/hold filtering. */
  opFilteredCount: number;
  onOpenDossier?: (dossier: string) => void;
  sealHistory?: number[];
  sealHistoryPending?: boolean;
  sealHistoryError?: boolean;
  sealHistoryApplicable?: boolean;
}

export function BoardHeader({
  operations,
  cycles,
  tasks,
  activeOp,
  filteredCount,
  opFilteredCount,
  onOpenDossier,
  sealHistory = [],
  sealHistoryPending = false,
  sealHistoryError = false,
  sealHistoryApplicable = true,
}: BoardHeaderProps) {
  // Field selectors — the shell must not re-render on ephemeral modal state.
  const mode = useBoardStore((s) => s.mode);
  const setMode = useBoardStore((s) => s.setMode);
  const filter = useBoardStore((s) => s.filter);
  const setFilter = useBoardStore((s) => s.setFilter);

  // Stats
  const open = tasks.filter((t) => t.status !== "SEALED").length;
  const inField = tasks.filter((t) => t.status === "FIELD").length;
  const onHold = tasks.filter((t) => Boolean(t.hold)).length;

  const opHealthColor = healthColor(activeOp?.health ?? "");

  return (
    <header className="flex-none overflow-hidden border-b border-[var(--rule)] bg-[var(--paper-2)]">
      {/* Top strip: title · mode toggles · stats */}
      <div className="flex items-center gap-[18px] px-[var(--pad)] pb-[10px] pt-[12px]">
        {/* Title block */}
        <div className="flex flex-col gap-[1px]">
          <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
            OPS REGISTER / {operations.length} OPERATIONS · {cycles.length}{" "}
            CYCLES
          </span>
          <h1 className="font-sans text-[22px] font-black uppercase leading-none tracking-[0.04em] text-[var(--ink)]">
            TASKING BOARD
          </h1>
        </div>

        {/* Mode toggles */}
        <div
          role="tablist"
          className="flex border border-[var(--rule)] bg-[var(--paper)]"
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={cn(
                "cl-mono inline-flex cursor-pointer items-center gap-[7px] border-r border-[var(--rule)] px-[14px] py-[5px] text-[9px] uppercase tracking-[0.18em] transition-colors last:border-r-0",
                mode === m.id
                  ? "bg-[var(--ink)] text-[var(--paper)]"
                  : "text-[var(--ink-mute)] hover:bg-[var(--paper-edge)] hover:text-[var(--ink-2)]",
              )}
              onClick={() => setMode(m.id)}
            >
              <ModeGlyph gl={m.gl} />
              {m.label}
            </button>
          ))}
        </div>

        {/* Stats — pushed to the right */}
        <div className="ml-auto flex items-center gap-[22px]">
          {/* OPEN */}
          <div className="flex flex-col gap-[1px] text-right">
            <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              OPEN
            </span>
            <span className="font-sans text-[20px] font-black leading-none tabular-nums text-[var(--ink)]">
              {pad2(open)}
            </span>
          </div>

          {/* IN-FIELD */}
          <div className="flex flex-col gap-[1px] text-right">
            <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              IN-FIELD
            </span>
            <span
              className="font-sans text-[20px] font-black leading-none tabular-nums"
              style={{ color: "var(--cool)" }}
            >
              {pad2(inField)}
            </span>
          </div>

          {/* ON HOLD */}
          <div className="flex flex-col gap-[1px] text-right">
            <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              ON HOLD
            </span>
            <span
              className="font-sans text-[20px] font-black leading-none tabular-nums"
              style={{ color: onHold > 0 ? "var(--hot)" : "var(--ink)" }}
            >
              {pad2(onHold)}
            </span>
          </div>

          {/* SEAL RATE 14d sparkline */}
          <div className="flex flex-col gap-[1px] pb-[2px] text-right">
            <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              SEAL RATE 14d
            </span>
            {!sealHistoryApplicable ? (
              <span className="text-[9px] text-[var(--ink-mute)]">
                NOT APPLICABLE
              </span>
            ) : sealHistoryPending ? (
              <span className="text-[9px] text-[var(--ink-mute)]">LOADING</span>
            ) : sealHistoryError ? (
              <span className="text-[9px] text-[var(--hot)]">UNAVAILABLE</span>
            ) : sealHistory.length === 0 || sealHistory.every((count) => count === 0) ? (
              <span className="text-[9px] text-[var(--ink-mute)]">NO SEALS</span>
            ) : (
              <div aria-label={`14-day seal history: ${sealHistory.join(", ")}`}>
                <Spark
                  data={sealHistory}
                  width={96}
                  height={26}
                  accent="var(--cool)"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter strip: text search + priority toggles + hold toggle + count */}
      <div className="flex items-center gap-[10px] border-t border-[var(--rule-soft)] bg-[var(--paper)] px-[var(--pad)] py-[7px]">
        <input
          id="tasking-filter"
          data-testid="board-filter-input"
          type="text"
          placeholder="FILTER…"
          className="cl-mono w-[220px] border border-[var(--rule)] bg-transparent px-[8px] py-[4px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)]"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter({ ...filter, text: "" });
              e.currentTarget.blur();
              e.stopPropagation(); // don't let Escape reach the edit panel's window listener
            }
          }}
        />

        <div className="flex items-center gap-[4px]">
          {PRI_ORDER.map((p) => {
            const on = filter.pris.includes(p);
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                data-testid={`board-filter-pri-${p}`}
                className={cn(
                  "cl-mono border px-[7px] py-[3px] text-[9px] uppercase tracking-[0.1em] transition-colors",
                  on
                    ? "border-[var(--hot)] bg-[var(--hot)] text-[var(--paper)]"
                    : "border-[var(--rule)] text-[var(--ink-mute)] hover:text-[var(--ink-2)]",
                )}
                onClick={() =>
                  setFilter({
                    ...filter,
                    pris: on
                      ? filter.pris.filter((x) => x !== p)
                      : [...filter.pris, p],
                  })
                }
              >
                {p}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={filter.holdOnly}
            data-testid="board-filter-hold"
            className={cn(
              "cl-mono border px-[7px] py-[3px] text-[9px] uppercase tracking-[0.1em] transition-colors",
              filter.holdOnly
                ? "border-[var(--hot)] bg-[var(--hot)] text-[var(--paper)]"
                : "border-[var(--rule)] text-[var(--ink-mute)] hover:text-[var(--ink-2)]",
            )}
            onClick={() => setFilter({ ...filter, holdOnly: !filter.holdOnly })}
          >
            HOLD
          </button>
        </div>

        {isFilterActive(filter) && (
          <span
            data-testid="board-filter-count"
            className="cl-mono ml-auto text-[9px] uppercase tracking-[0.15em] text-[var(--ink-mute)]"
          >
            {pad2(filteredCount)} OF {pad2(opFilteredCount)}
          </span>
        )}
      </div>

      {/* Op-meta line — only when a real op is selected */}
      {activeOp && (
        <div className="flex items-center gap-[14px] overflow-hidden whitespace-nowrap border-t border-[var(--rule-soft)] bg-[var(--paper)] px-[var(--pad)] py-[7px] text-[9px] uppercase tracking-[0.12em] text-[var(--ink-mute)]">
          <HealthDot health={activeOp.health} />
          <span className="font-medium text-[var(--ink)]">{activeOp.name}</span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>
            LEAD
            <b className="ml-[5px] font-medium text-[var(--ink)]">
              {activeOp.lead ?? "—"}
            </b>
          </span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>
            HEALTH
            <b className="ml-[5px] font-medium" style={{ color: opHealthColor }}>
              {activeOp.health}
            </b>
          </span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>
            TARGET
            <b className="ml-[5px] font-medium text-[var(--ink)]">
              {activeOp.target ?? "—"}
            </b>
          </span>
          {activeOp.dossier && (
            <>
              <span className="text-[var(--ink-faint)]">·</span>
              <span>
                DOSSIER{" "}
                <button
                  type="button"
                  className="cursor-pointer border-b border-dotted border-[var(--cool)] text-[var(--cool)] transition-colors hover:bg-[var(--cool)] hover:text-[var(--paper)]"
                  onClick={() => onOpenDossier?.(activeOp.dossier!)}
                >
                  {activeOp.dossier}
                </button>
              </span>
            </>
          )}
          {activeOp.note && (
            <>
              <span className="text-[var(--ink-faint)]">·</span>
              <span className="overflow-hidden text-ellipsis text-[9px] normal-case tracking-[0.02em] text-[var(--ink-2)]">
                {activeOp.note}
              </span>
            </>
          )}
        </div>
      )}
    </header>
  );
}
