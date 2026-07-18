// CLEPSYDRA — Graph / constellation view

function GraphView({ data, onOpen }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const onResize = () => {
      if (!wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // deterministic positions on a polar field
  const nodes = useMemo(() => {
    const ns = data.archive.slice(0, 60);
    const cx = size.w / 2, cy = size.h / 2;
    return ns.map((n, i) => {
      const ring = (i % 5) + 1;
      const angle = (i * 137.508) * (Math.PI / 180);
      const r = ring * Math.min(size.w, size.h) * 0.08 + 40;
      return {
        ...n,
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        r: ring,
        size: 2 + (n.kind === "PROJECT" ? 3 : n.kind === "DAILY" ? 1.5 : 2),
      };
    });
  }, [data, size]);

  const edges = useMemo(() => {
    const es = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const sameRing = a.r === b.r;
        const sharedTag = (a.tags || []).some(t => (b.tags || []).includes(t));
        if (sharedTag && sameRing && Math.random() < 0.55) {
          es.push([i, j]);
        } else if (sharedTag && Math.abs(a.r - b.r) === 1 && (i * j) % 7 === 0) {
          es.push([i, j]);
        }
      }
    }
    return es;
  }, [nodes]);

  // sweep animation
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    let raf;
    const tick = () => {
      setSweep(s => (s + 0.4) % 360);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cx = size.w / 2, cy = size.h / 2;
  const maxR = Math.min(size.w, size.h) * 0.45;

  return (
    <div className="graph" ref={wrapRef}>
      <svg width={size.w} height={size.h} className="graph-svg">
        {/* Concentric range rings */}
        {[1,2,3,4,5].map(i => (
          <circle key={i} cx={cx} cy={cy} r={i * (maxR/5)} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" strokeDasharray={i % 2 ? "1 3" : "1 1"} />
        ))}
        {/* Cross-hairs */}
        <line x1={cx} y1={0} x2={cx} y2={size.h} stroke="currentColor" strokeOpacity="0.12" />
        <line x1={0} y1={cy} x2={size.w} y2={cy} stroke="currentColor" strokeOpacity="0.12" />
        {/* Bearings */}
        {Array.from({ length: 36 }).map((_, i) => {
          const a = (i * 10) * (Math.PI / 180);
          const r1 = maxR;
          const r2 = maxR + 6;
          const x1 = cx + Math.cos(a) * r1;
          const y1 = cy + Math.sin(a) * r1;
          const x2 = cx + Math.cos(a) * r2;
          const y2 = cy + Math.sin(a) * r2;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeOpacity={i % 9 === 0 ? "0.6" : "0.3"} />;
        })}
        {/* Bearing labels */}
        {[0, 90, 180, 270].map(d => {
          const a = d * (Math.PI / 180);
          const x = cx + Math.cos(a) * (maxR + 18);
          const y = cy + Math.sin(a) * (maxR + 18);
          return <text key={d} x={x} y={y} fill="currentColor" fontSize="9" textAnchor="middle" dominantBaseline="middle" letterSpacing="0.16em" opacity="0.7">{String(d).padStart(3,"0")}°</text>;
        })}
        {/* Edges */}
        {edges.map(([i, j], k) => {
          const a = nodes[i], b = nodes[j];
          return (
            <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="currentColor" strokeOpacity="0.22" strokeWidth="0.6" />
          );
        })}
        {/* Sweep wedge */}
        <defs>
          <linearGradient id="sweepg" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--cool)" stopOpacity="0.0" />
            <stop offset="100%" stopColor="var(--cool)" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <g transform={`rotate(${sweep} ${cx} ${cy})`}>
          <path d={`M ${cx} ${cy} L ${cx + maxR} ${cy} A ${maxR} ${maxR} 0 0 0 ${cx + Math.cos(-Math.PI/9)*maxR} ${cy + Math.sin(-Math.PI/9)*maxR} Z`}
            fill="url(#sweepg)" />
        </g>
        {/* Nodes */}
        {nodes.map((n, i) => {
          const isHover = hover === n.id;
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onOpen?.(n.id)}
              style={{ cursor: "default" }}
            >
              <circle r={n.size + 6} fill="transparent" />
              {n.kind === "PROJECT" ? (
                <rect x={-n.size} y={-n.size} width={n.size * 2} height={n.size * 2} fill="currentColor" />
              ) : n.kind === "DAILY" ? (
                <circle r={n.size} fill="none" stroke="currentColor" strokeWidth="1" />
              ) : n.kind === "TASK" ? (
                <polygon points={`0,${-n.size} ${n.size},${n.size} ${-n.size},${n.size}`} fill="currentColor" />
              ) : (
                <circle r={n.size} fill="currentColor" />
              )}
              {isHover && (
                <>
                  <circle r={n.size + 4} fill="none" stroke="var(--hot)" strokeWidth="1" />
                  <line x1={n.size + 6} y1={0} x2={n.size + 22} y2={-12} stroke="var(--hot)" />
                  <text x={n.size + 24} y={-14} fill="var(--hot)" fontSize="9" letterSpacing="0.12em">{n.id}</text>
                  <text x={n.size + 24} y={-4} fill="currentColor" fontSize="9">{n.title.slice(0, 36)}</text>
                </>
              )}
            </g>
          );
        })}
        {/* Center reticle */}
        <circle cx={cx} cy={cy} r="3" fill="none" stroke="var(--hot)" />
        <line x1={cx-7} y1={cy} x2={cx-3} y2={cy} stroke="var(--hot)" />
        <line x1={cx+3} y1={cy} x2={cx+7} y2={cy} stroke="var(--hot)" />
        <line x1={cx} y1={cy-7} x2={cx} y2={cy-3} stroke="var(--hot)" />
        <line x1={cx} y1={cy+3} x2={cx} y2={cy+7} stroke="var(--hot)" />
      </svg>

      {/* Overlay legend */}
      <div className="graph-legend">
        <div className="label">LEGEND / NODE-KIND</div>
        <div className="lg-row"><span className="lg-dot circ"></span> FRAGMENT / QUOTE / CAPTURE</div>
        <div className="lg-row"><span className="lg-dot ring"></span> DAILY</div>
        <div className="lg-row"><span className="lg-dot tri"></span> TASK</div>
        <div className="lg-row"><span className="lg-dot sq"></span> PROJECT</div>
        <div className="hr-dash" style={{ margin: "8px 0" }}></div>
        <div className="label">TOTAL</div>
        <div>{nodes.length} NODES · {edges.length} EDGES</div>
      </div>

      <div className="graph-readout">
        <div className="label">SWEEP</div>
        <div>BRG <b>{String(Math.round(sweep)).padStart(3,"0")}°</b></div>
        <div className="label" style={{marginTop:6}}>RANGE</div>
        <div>R1–R5 / {Math.round(maxR)}px</div>
        <div className="label" style={{marginTop:6}}>FOCUS</div>
        <div>{hover || "—"}</div>
      </div>
    </div>
  );
}

window.GraphView = GraphView;
