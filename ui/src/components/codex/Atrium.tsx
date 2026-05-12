import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import SunCalc from "suncalc";
import { useBcl } from "#/api/bcl";
import { useContentIndex, useStats, useTags } from "#/api/index";
import { useLocation } from "#/api/location";
import { ASCII_COMPASS, MiniAsciiAnimation } from "#/components/codex/ascii";
import { CLink } from "#/components/codex/CLink";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { shortFolio } from "#/components/codex/folio-utils";
import { InscribeModal } from "#/components/codex/InscribeModal";
import { useOpenTab } from "#/hooks/useOpenTab";

export function Atrium() {
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const [inscribeOpen, setInscribeOpen] = useState(false);
  const { data: stats } = useStats();
  const { data: tags } = useTags();
  const { data: content } = useContentIndex(40);
  const { data: bcl } = useBcl();
  const { data: location } = useLocation();

  const recent = useMemo(() => {
    const items = content?.items ?? [];
    return [...items]
      .sort((a, b) => {
        const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
        const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
        return tb - ta;
      })
      .slice(0, 7);
  }, [content]);

  const totalEntries = stats?.pages ?? 0;
  const totalLinks = stats?.links_total ?? 0;
  const totalTags = stats?.tags ?? 0;

  const horoLabel = useMemo(() => {
    const now = new Date();
    const lat = location?.latitude ?? null;
    const lon = location?.longitude ?? null;
    const sunsetMs =
      lat !== null && lon !== null
        ? SunCalc.getTimes(now, lat, lon).sunset.getTime()
        : new Date(now).setHours(19, 0, 0, 0);
    const remainingMin = Math.max(
      0,
      Math.floor((sunsetMs - now.getTime()) / 60_000),
    );
    const h = Math.floor(remainingMin / 60);
    const m = remainingMin % 60;
    return {
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      remaining: `${h}h ${pad(m)}m of light remaining`,
      place: location?.label ?? null,
    };
  }, [location?.latitude, location?.longitude, location?.label]);

  const showProspective =
    import.meta.env.VITE_ENABLE_PROSPECTIVE_PANELS === "1";

  return (
    <div className="grid gap-4 px-5 py-4 lg:grid-cols-[2fr_1fr]">
      {/* LEFT */}
      <div>
        {/* Frontispiece */}
        <div className="cl-frame relative mb-3 px-5 py-4">
          <div className="cl-cap absolute left-3 top-2 text-[9px] text-ink-mute">
            FRONTISPIECE
          </div>
          <div className="cl-cap absolute right-3 top-2 text-[9px] text-ink-mute">
            PL. I
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-6 pt-3">
            <FrontispieceAnimation />
            <div>
              <div className="cl-cap cl-cap-wide text-[34px] font-bold leading-none">
                WELCOME,
                <br />
                READER
              </div>
              <hr className="cl-rule-double my-[10px] mb-2 mt-[10px] border-accent" />
              <p className="cl-serif m-0 text-[16px] italic leading-[1.5] text-ink-2">
                You hold open a private codex. {totalEntries} folios indexed,{" "}
                {totalLinks} cross-references, {totalTags} subjects distinct.
                The clepsydra's water is{" "}
                <span className="border-b border-dotted border-ink">
                  three-quarters spent
                </span>
                ; let us proceed.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="cl-btn"
                  onClick={() => navigate({ to: "/journal" })}
                >
                  Today's Diurnal
                </button>
                {recent[0] && (
                  <button
                    type="button"
                    className="cl-btn"
                    onClick={() =>
                      openTab(
                        "page",
                        recent[0].path,
                        recent[0].title || recent[0].path,
                      )
                    }
                  >
                    Resume Folio {shortFolio(recent[0].path)}
                  </button>
                )}
                <button
                  type="button"
                  className="cl-btn cl-btn-hot"
                  onClick={() => setInscribeOpen(true)}
                >
                  + Inscribe
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Brimley-Cocoon Line — only when ~/.config/bcl (or vault copy) is present. */}
        {bcl?.birth_date && bcl.bcl_date && bcl.remaining_seconds !== null && (
          <div className="cl-frame relative mb-3 px-5 py-3">
            <div className="cl-cap absolute left-3 top-2 text-[9px] text-ink-mute">
              § BRIMLEY-COCOON LINE
            </div>
            <div className="cl-cap absolute right-3 top-2 text-[9px] text-ink-mute">
              PL. I bis
            </div>
            <div className="grid grid-cols-[auto_1fr] items-baseline gap-5 pt-3">
              <div className="cl-mono text-[22px] leading-none text-accent-deep">
                {fmtBclDuration(bcl.remaining_seconds)}
              </div>
              <div className="cl-leader">
                <span className="cl-serif italic text-[12px]">
                  {bcl.remaining_seconds >= 0
                    ? "line to be crossed on"
                    : "line crossed on"}{" "}
                  {fmtBclDate(bcl.bcl_date)}
                </span>
                <span className="cl-leader-dots" />
                <span className="cl-mono text-[10px] text-ink-mute">
                  natal {bcl.birth_date}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Recently Inscribed */}
        <div className="cl-cap mb-1 flex items-baseline justify-between text-[10px]">
          <span>§ Recently Inscribed</span>
          <span className="text-[9px] text-ink-mute">
            {romanLower(Math.min(recent.length, totalEntries))} of{" "}
            {romanLower(totalEntries)}
          </span>
        </div>
        <hr className="cl-rule-soft mt-1" />
        <table className="mt-1 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-rule border-t-[1.5px]">
              <Th width={64}>FOL.</Th>
              <Th>TITLE</Th>
              <Th width={180}>SUBJECT</Th>
              <Th width={60} align="right">
                BACK.
              </Th>
              <Th width={80} align="right">
                WHEN
              </Th>
            </tr>
          </thead>
          <tbody>
            {recent.map((n) => (
              <tr
                key={n.path}
                onClick={() => openTab("page", n.path, n.title || n.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    openTab("page", n.path, n.title || n.path);
                }}
                className="cursor-pointer border-b border-dotted border-rule-soft"
              >
                <td className="cl-mono px-1 py-1 text-[11px] text-ink-mute">
                  {shortFolio(n.path)}
                </td>
                <td className="cl-serif px-1 py-1">
                  <span className="font-medium">{n.title || n.path}</span>
                </td>
                <td className="cl-mono px-1 py-1 text-[10px] text-accent-deep">
                  {(n.tags || []).slice(0, 3).join(" · ") || "—"}
                </td>
                <td className="cl-mono px-1 py-1 text-right text-[10px]">
                  {n.links?.length ?? 0}
                </td>
                <td className="cl-mono px-1 py-1 text-right text-[10px] text-ink-mute">
                  {formatRelativeTime(n.updated_at)}
                </td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={5} className="cl-marg px-1 py-3 text-center">
                  ⁂ no folios yet inscribed.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Reading + Inquiry */}
        {showProspective && (
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div>
              <div className="cl-cap mb-1 text-[10px]">§ Reading Continues</div>
              <hr className="cl-rule-soft" />
              <div className="mt-1 space-y-[2px]">
                <Leader
                  left={
                    <span className="cl-serif italic">
                      Calvino · Invisible Cities
                    </span>
                  }
                  right="p. 84/165"
                />
                <Leader
                  left={
                    <span className="cl-serif italic">Borges · Ficciones</span>
                  }
                  right="p. 142/220"
                />
                <Leader
                  left={
                    <span className="cl-serif italic">
                      Murray · APL — interactive approach
                    </span>
                  }
                  right="p. 28/318"
                />
              </div>
            </div>
            <div>
              <div className="cl-cap mb-1 text-[10px]">§ Inquiry, open</div>
              <hr className="cl-rule-soft" />
              <ul className="cl-serif m-0 list-none p-0 text-[12px]">
                <li className="mb-[2px]">
                  ◇{" "}
                  <span className="italic">
                    Why does Polars surprise on string ops?
                  </span>
                </li>
                <li className="mb-[2px]">
                  ◇ Test Maillard at 130°C against 150°C, same beef
                </li>
                <li className="mb-[2px]">
                  ◆{" "}
                  <span className="italic">
                    What does Weil mean by "decreation"?
                  </span>
                </li>
                <li>◇ Re-read the Babel piece; index by character</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT — marginalia */}
      <div className="border-l border-rule-soft pl-4">
        {/* Horologe */}
        {showProspective && (
          <div className="cl-frame mb-3 bg-paper-2 px-3 py-2">
            <div className="cl-cap mb-1 text-[9px] text-ink-mute">HOROLOGE</div>
            <div className="flex items-center gap-3">
              <div className="relative h-[60px] w-[42px]">
                {/* Hourglass silhouette via clipPath — keep inline (no utility for this). */}
                <div
                  className="absolute inset-0 border-[1.5px] border-ink"
                  style={{
                    clipPath:
                      "polygon(0 0, 100% 0, 50% 50%, 100% 100%, 0 100%, 50% 50%)",
                  }}
                />
                <div className="absolute inset-x-0 top-0 h-[18%] bg-paper" />
                <div className="absolute inset-x-0 bottom-0 h-[56%] bg-accent opacity-80" />
              </div>
              <div>
                <div className="cl-mono text-[18px]">{horoLabel.time}</div>
                <div className="cl-marg">{horoLabel.remaining}</div>
                {horoLabel.place && (
                  <div className="cl-marg italic">at {horoLabel.place}</div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="cl-cap mb-1 text-[9px]">§ The Codex Contains</div>
        <hr className="cl-rule" />
        <div className="cl-serif mt-1 text-[11px]">
          {(
            [
              ["Folios, total", String(stats?.pages ?? 0)],
              ["Cross-references", String(stats?.links_total ?? 0)],
              ["Unresolved", String(stats?.links_unresolved ?? 0)],
              ["Subjects, distinct", String(stats?.tags ?? 0)],
            ] as const
          ).map(([k, v]) => (
            <div className="cl-leader mb-[1px]" key={k}>
              <span className="italic">{k}</span>
              <span className="cl-leader-dots" />
              <span className="cl-mono text-[10px]">{v}</span>
            </div>
          ))}
        </div>

        <div className="cl-cap mb-1 mt-4 text-[9px]">
          § Subjects, by Frequency
        </div>
        <hr className="cl-rule" />
        <div className="mt-2 flex flex-wrap gap-x-[6px] gap-y-[3px]">
          {(tags ?? []).slice(0, 16).map((t) => (
            <CLink
              key={t.tag}
              noNavigate
              payload={{
                title: `#${t.tag}`,
                folio: "Subject",
                excerpt: `${t.count} folio${t.count === 1 ? "" : "s"} indexed under #${t.tag}.`,
                tags: [t.tag],
              }}
              onClick={() =>
                navigate({ to: "/gazetteer", search: { tag: t.tag } as never })
              }
            >
              <span className="cl-mono text-[11px] text-accent-deep">
                #{t.tag}
                <sup className="ml-[2px] text-ink-mute">{t.count}</sup>
              </span>
            </CLink>
          ))}
        </div>

        <div className="mt-5 flex justify-center">
          <div className="cl-stamp">Privatim · Lectori Suo</div>
        </div>

        <pre className="cl-ascii cl-ascii-faint mt-4 text-center text-[6px]">
          {ASCII_COMPASS}
        </pre>
        <p className="cl-marg mt-1 text-center">
          — fig. iii.{" "}
          <span className="italic">compass rose, after Mercator —</span>
        </p>
      </div>
      {inscribeOpen && <InscribeModal onClose={() => setInscribeOpen(false)} />}
    </div>
  );
}

function FrontispieceAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const rootStyles = getComputedStyle(document.documentElement);
    const animation = new MiniAsciiAnimation(canvas, {
      background: cssVar(rootStyles, "--paper-2", "#e8e0cc"),
      textColor: cssVar(rootStyles, "--accent", "#0c6cad"),
      fontFamily: cssVar(rootStyles, "--font-mono", "monospace"),
    });

    animation.start();

    return () => animation.stop();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="block h-[190px] w-[190px] border border-rule-soft bg-paper-2"
      aria-label="Animated ASCII frontispiece made from codex text"
    />
  );
}

/* helpers --------------------------------------------------------------- */

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}

function Th({
  children,
  width,
  align = "left",
}: {
  children: ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`cl-cap px-1 py-[3px] text-[9px] text-ink-mute ${align === "right" ? "text-right" : "text-left"}`}
      style={width !== undefined ? { width } : undefined}
    >
      {children}
    </th>
  );
}

function Leader({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="cl-leader">
      {left}
      <span className="cl-leader-dots" />
      <span className="cl-mono text-[10px]">{right}</span>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtBclDuration(totalSeconds: number): string {
  const past = totalSeconds < 0;
  const s = Math.abs(totalSeconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const prefix = past ? "+" : "";
  return `${prefix}${days.toLocaleString("en-US")}d · ${hours}h`;
}

function fmtBclDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-").map((p) => Number.parseInt(p, 10));
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

const LOWERS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
function romanLower(n: number): string {
  if (n <= 0) return "—";
  if (n < 11) return LOWERS[n - 1];
  if (n < 100)
    return `${Math.floor(n / 10)}·${LOWERS[(n % 10) - 1] || ""}`.replace(
      /·$/,
      "",
    );
  return `${Math.floor(n / 100)}·${Math.floor((n % 100) / 10)}·${n % 10 || ""}`.replace(
    /·$/,
    "",
  );
}
