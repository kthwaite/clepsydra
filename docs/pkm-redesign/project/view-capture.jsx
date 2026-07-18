// CLEPSYDRA — Capture / new entry terminal

function CaptureView({ onCommit }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("FRAGMENT");
  const [tags, setTags] = useState("EPISTEMICS, ARCHIVE");
  const [committed, setCommitted] = useState(false);

  const wc = body.trim() ? body.trim().split(/\s+/).length : 0;
  const id = "CLP-" + String(Math.floor(Math.random() * 9000) + 1000) + "-X";

  const commit = () => {
    setCommitted(true);
    setTimeout(() => setCommitted(false), 1800);
  };

  return (
    <div className="capture">
      <div className="capture-l">
        <div className="capture-hd">
          <div className="label">FORM CLP-INTAKE-04 / REV.07</div>
          <h1 className="capture-h">INTAKE TERMINAL</h1>
          <div className="dim">CAPTURE PRECEDES CLASSIFICATION (P-01)</div>
        </div>

        <div className="cap-field">
          <label className="label">FIELD 01 — DESIGNATION</label>
          <input className="cap-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="ENTER TITLE / 80 CHAR MAX" maxLength={80} />
          <div className="cap-meta"><span>{title.length} / 80</span><span>REQUIRED</span></div>
        </div>

        <div className="cap-row-2">
          <div className="cap-field">
            <label className="label">FIELD 02 — KIND</label>
            <div className="cap-radios">
              {["FRAGMENT","DAILY","TASK","QUOTE","CAPTURE","CODE"].map(k => (
                <button key={k} className={"cap-radio " + (kind===k?"on":"")} onClick={()=>setKind(k)}>{k}</button>
              ))}
            </div>
          </div>
          <div className="cap-field">
            <label className="label">FIELD 03 — TAGS</label>
            <input className="cap-input" value={tags} onChange={e => setTags(e.target.value)} placeholder="COMMA-SEP" />
            <div className="cap-meta"><span>{tags.split(",").filter(Boolean).length} TAGS</span></div>
          </div>
        </div>

        <div className="cap-field">
          <label className="label">FIELD 04 — BODY</label>
          <textarea className="cap-area" rows={14} value={body} onChange={e => setBody(e.target.value)}
            placeholder="ENTER OBSERVATIONAL TEXT. CAPTURE FIRST, CLASSIFY LATER. P-01."></textarea>
          <div className="cap-meta">
            <span>WC <b>{wc}</b></span>
            <span>LINES <b>{body.split("\n").length}</b></span>
            <span>BYTES <b>{new Blob([body]).size}</b></span>
          </div>
        </div>

        <div className="cap-field">
          <label className="label">FIELD 05 — ATTACHMENT</label>
          <div className="cap-attach">
            <span className="dim">[ NO FILE ]</span>
            <button className="cap-radio">SELECT</button>
            <button className="cap-radio">PASTE FROM CLIPBOARD</button>
            <button className="cap-radio">RECORD VOICE</button>
          </div>
        </div>

        <div className="hr-dash"></div>

        <div className="cap-actions">
          <button className="cap-btn primary" onClick={commit}>▣ COMMIT TO ARCHIVE</button>
          <button className="cap-btn">SAVE DRAFT</button>
          <button className="cap-btn">DISCARD</button>
          <span className="dim" style={{ marginLeft: "auto" }}>⏎ to commit · ⌃D to discard</span>
        </div>

        {committed && (
          <div className="cap-confirm">
            <div className="label">↳ ACK</div>
            <div>FILE <b>{id}</b> SEALED · ROUTED TO INBOX</div>
            <div className="dim">RETRIEVABLE VIA QUERY: id:{id}</div>
          </div>
        )}
      </div>

      <aside className="capture-r">
        <div className="block">
          <div className="label">PROVENANCE</div>
          <div className="kv"><span>OPERATOR</span><b>0xC1</b></div>
          <div className="kv"><span>STATION</span><b>SEA-14</b></div>
          <div className="kv"><span>TERMINAL</span><b>TTY/04</b></div>
          <div className="kv"><span>SHIFT</span><b>NIGHT-3</b></div>
          <div className="kv"><span>UTC</span><b>{new Date().toISOString().slice(0,19).replace("T"," / ")}Z</b></div>
        </div>
        <div className="hr"></div>
        <div className="block">
          <div className="label">PROPOSED ID</div>
          <div className="big-id">{id}</div>
        </div>
        <div className="hr"></div>
        <div className="block">
          <div className="label">VALIDATION</div>
          <div className="cap-check"><span className={title?"ok":"warn"}>{title?"✓":"○"}</span> TITLE PRESENT</div>
          <div className="cap-check"><span className={kind?"ok":"warn"}>✓</span> KIND ASSIGNED</div>
          <div className="cap-check"><span className={tags?"ok":"warn"}>{tags?"✓":"○"}</span> AT LEAST 1 TAG</div>
          <div className="cap-check"><span className={body.length>10?"ok":"warn"}>{body.length>10?"✓":"○"}</span> BODY ≥ 10 CHARS</div>
          <div className="cap-check"><span className="ok">✓</span> CLOCK SYNCED</div>
        </div>
        <div className="hr"></div>
        <div className="block">
          <div className="label">RELATED CHANNELS</div>
          <div className="dim sm">SEMANTIC DRAFT · 0.31</div>
          <div>↳ CLP-2741-A · ON THE TYRANNY...</div>
          <div>↳ CLP-1102-D · INVENTORY OF...</div>
          <div>↳ CLP-0017-B · ON DOSSIERS</div>
        </div>
      </aside>
    </div>
  );
}

window.CaptureView = CaptureView;
