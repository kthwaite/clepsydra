// CLEPSYDRA — small reusable bits

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ── Brand glyph ──────────────────────────────────────────────────────
function Glyph({ size = 16 }) {
  return (
    <a
      href="SPLASH.html"
      className="glyph glyph-link"
      style={{ fontSize: size, cursor: "pointer" }}
      title="Return to daystart"
    >
      CLEPSYDRA<span className="accent">/</span>VII
    </a>
  );
}

// ── Classification banner ────────────────────────────────────────────
function ClassBanner({ text, position = "top" }) {
  return (
    <div className={"banner" + (position === "bottom" ? " bottom" : "")}>
      <span>{text}</span>
      <span className="dots"></span>
      <span>HANDLE VIA CLEPSYDRA-7 CHANNELS ONLY</span>
      <span className="dots"></span>
      <span>{text}</span>
    </div>
  );
}

// ── Live ticker (top) ────────────────────────────────────────────────
function Ticker({ stats }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const stamp = now.toISOString().replace("T", " / ").slice(0, 19) + "Z";
  return (
    <div className="ticker">
      <span className="item"><span className="pip cool"></span><b>LINK</b> NOMINAL</span>
      <span className="item"><span className="pip"></span>SIG <b>−47.2dBm</b></span>
      <span className="item"><span className="pip"></span>BUFFER <b>14.6%</b></span>
      <span className="item"><span className="pip hot"></span>QUEUE <b>{stats.indexedToday}/47</b></span>
      <span className="item"><span className="pip"></span>UPTIME <b>{stats.uptime}</b></span>
      <span className="item"><span className="pip cool"></span>UTC <b>{stamp}</b></span>
      <span className="item">LAT/LON <b>47.6062 / −122.3321</b></span>
      <span className="item">SHIFT <b>NIGHT-3</b></span>
      <span className="item">OPERATOR <b>0xC1</b></span>
    </div>
  );
}

// ── Tag pill ─────────────────────────────────────────────────────────
function Tag({ children, tone }) {
  return <span className={"tag " + (tone || "")}>{children}</span>;
}

// ── Hatched/dithered placeholder block ───────────────────────────────
function Hatch({ w = "100%", h = 80, density = 4, label }) {
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <defs>
        <pattern id={"hp" + density} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth={1 / density} opacity="0.6" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#hp${density})`} opacity="0.5" />
      <rect width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      {label && (
        <text x="6" y="12" fontFamily="var(--mono)" fontSize="9" fill="currentColor" letterSpacing="0.16em" opacity="0.8">
          {label}
        </text>
      )}
    </svg>
  );
}

// ── Sparkline (mini chart) ───────────────────────────────────────────
function Spark({ data, width = 120, height = 24, accent }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 2) - 1}`).join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={accent || "currentColor"} strokeWidth="1" />
    </svg>
  );
}

// ── Pixel/dithered "ID photo" block ──────────────────────────────────
function IDPhoto({ size = 80, seed = 7 }) {
  const cells = [];
  let s = seed;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      s = (s * 9301 + 49297) % 233280;
      const r = s / 233280;
      // Roughly head-shaped mask
      const dx = (x - 12) / 10;
      const dy = (y - 11) / 12;
      const inMask = dx * dx + dy * dy < 1;
      const v = inMask ? r * 0.9 + 0.1 : r * 0.3;
      const shade = v > 0.65 ? "currentColor" : v > 0.45 ? "rgba(255,255,255,0.5)" : "transparent";
      cells.push(<rect key={x + "," + y} x={x} y={y} width="1" height="1" fill={shade} />);
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", imageRendering: "pixelated" }}>
      {cells}
      <rect x="0" y="0" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="0.4" />
    </svg>
  );
}

// ── Asciibar progress ────────────────────────────────────────────────
function AsciiBar({ value = 0.5, width = 24 }) {
  const filled = Math.round(value * width);
  return (
    <span style={{ fontFamily: "var(--mono)" }}>
      [{"█".repeat(filled)}{"·".repeat(width - filled)}]
    </span>
  );
}

window.CLEP_UI = {
  Glyph, ClassBanner, Ticker, Tag, Hatch, Spark, IDPhoto, AsciiBar,
};
