// CLEPSYDRA — Settings / system status

const { Spark: SparkS, Hatch: HatchS } = window.CLEP_UI;

function SettingsView({ data }) {
  const subsystems = [
    { name: "INDEXER",        state: "NOMINAL", load: 0.34, lat: "12ms",  uptime: "412d" },
    { name: "FT-SEARCH",      state: "NOMINAL", load: 0.21, lat: "08ms",  uptime: "412d" },
    { name: "GRAPH-CACHE",    state: "NOMINAL", load: 0.62, lat: "44ms",  uptime: "118d" },
    { name: "SYNC / SIGNAL-3",state: "DEGRADED",load: 0.81, lat: "210ms", uptime: "06d"  },
    { name: "BACKUP / COLD",  state: "NOMINAL", load: 0.04, lat: "—",     uptime: "412d" },
    { name: "OCR / INTAKE",   state: "NOMINAL", load: 0.18, lat: "31ms",  uptime: "412d" },
    { name: "EMBED / VEC",    state: "NOMINAL", load: 0.55, lat: "92ms",  uptime: "21d"  },
    { name: "LOCK / CRYPTO",  state: "ARMED",   load: 0.00, lat: "—",     uptime: "412d" },
  ];

  return (
    <div className="settings">
      <div className="settings-grid">
        <section className="set-card span-2">
          <div className="set-hd">
            <div>
              <div className="label">PANEL 01</div>
              <h2 className="set-h">SYSTEM STATUS</h2>
            </div>
            <div className="dim">POLLED 2s · NEXT IN 1s</div>
          </div>
          <div className="hr-dash"></div>
          <div className="sub-table">
            <div className="sub-r sub-h">
              <span>SUBSYSTEM</span>
              <span>STATE</span>
              <span>LOAD</span>
              <span>LATENCY</span>
              <span>UPTIME</span>
            </div>
            {subsystems.map(s => (
              <div key={s.name} className="sub-r">
                <span><span className={"pip " + (s.state === "DEGRADED" ? "hot" : "cool")}></span>{s.name}</span>
                <span className={s.state === "DEGRADED" ? "hotc" : ""}>{s.state}</span>
                <span><div className="bar"><i style={{ width: (s.load*100)+"%", background: s.load > 0.75 ? "var(--hot)" : "var(--cool)" }}></i></div></span>
                <span>{s.lat}</span>
                <span>{s.uptime}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="set-card">
          <div className="set-hd"><div><div className="label">PANEL 02</div><h2 className="set-h">CORPUS</h2></div></div>
          <div className="hr-dash"></div>
          <div className="kv"><span>FILES</span><b>{data.stats.total.toLocaleString()}</b></div>
          <div className="kv"><span>LINKS</span><b>{data.stats.links.toLocaleString()}</b></div>
          <div className="kv"><span>TAGS</span><b>{data.stats.tags}</b></div>
          <div className="kv"><span>ORPHANS</span><b className="hotc">{data.stats.orphans}</b></div>
          <div className="kv"><span>MEDIAN AGE</span><b>04d 11h</b></div>
          <div className="kv"><span>ON-DISK</span><b>2.41 GiB</b></div>
          <div className="hr-dash" style={{margin:"8px 0"}}></div>
          <div className="label">CORPUS GROWTH 90d</div>
          <SparkS data={[400,420,430,455,470,490,510,520,560,590,610,640,690,720,780,830,870,920,980,1050,1110,1180,1240,1310,1390,1470,1560,1640,1720]} width={260} height={48} accent="var(--cool)" />
        </section>

        <section className="set-card">
          <div className="set-hd"><div><div className="label">PANEL 03</div><h2 className="set-h">CRYPTO</h2></div></div>
          <div className="hr-dash"></div>
          <div className="kv"><span>VESSEL KEY</span><b>0xC1··A4F2</b></div>
          <div className="kv"><span>CIPHER</span><b>AGE / X25519</b></div>
          <div className="kv"><span>SEAL ROT.</span><b>30d / NEXT 12d</b></div>
          <div className="kv"><span>HASH</span><b>BLAKE3</b></div>
          <div className="kv"><span>WIPE</span><b>OFF</b></div>
          <div className="hr-dash" style={{margin:"8px 0"}}></div>
          <HatchS w="100%" h="60" density={3} label="ENTROPY POOL / 256b" />
        </section>

        <section className="set-card">
          <div className="set-hd"><div><div className="label">PANEL 04</div><h2 className="set-h">PRIORS</h2></div></div>
          <div className="hr-dash"></div>
          <div className="prior"><b>P-01</b> CAPTURE PRECEDES CLASSIFICATION <span className="ok">ENFORCED</span></div>
          <div className="prior"><b>P-02</b> CLASSIFICATION PRECEDES RETRIEVAL <span className="ok">ENFORCED</span></div>
          <div className="prior"><b>P-03</b> RETRIEVAL IS MECHANICAL, NOT INTERPRETIVE <span className="warn">ADVISORY</span></div>
          <div className="prior"><b>P-04</b> INBOX IS A CONSTRAINT, NOT A QUEUE <span className="ok">ENFORCED</span></div>
        </section>

        <section className="set-card span-2">
          <div className="set-hd"><div><div className="label">PANEL 05</div><h2 className="set-h">OPERATOR PREFERENCES</h2></div></div>
          <div className="hr-dash"></div>
          <div className="set-rows">
            <Row label="DAILY DIGEST" value="03:14Z · ENABLED" />
            <Row label="REVIEW SLA" value="48h" />
            <Row label="CADENCE FLOOR" value="04 captures / day" />
            <Row label="ORPHAN ALERT" value="≥ 300 → AMBER" />
            <Row label="COLLAPSE TRIPWIRE" value="0 captures / 72h" />
            <Row label="GRAPH MAX NODES" value="2,400 (lazy)" />
            <Row label="EMBED MODEL" value="LOCAL / e5-small-v2" />
            <Row label="REDACTION" value="OFF · OPERATOR γ-3" />
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="srow">
      <span className="label">{label}</span>
      <span className="dotline"></span>
      <b>{value}</b>
    </div>
  );
}

window.SettingsView = SettingsView;
