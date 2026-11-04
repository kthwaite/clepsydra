async (page) => {
  const S = [
    { name: "C1 Enter on wikilink-only bullet", md: "- [[Foo]]\n- next\n", steps: [["caretEnd",[0,0,0]],"Enter"] },
    { name: "C1v type after wikilink-only bullet", md: "- [[Foo]]\n", steps: [["caretEnd",[0,0,0]],["type","Z"]] },
    { name: "C2 Enter on emptied parent", md: "- x\n  - kid\n", steps: [["caret","x",-1],"Backspace","Enter"] },
    { name: "C2b Enter on emptied mid item", md: "- above\n- y\n- below\n", steps: [["caret","y",-1],"Backspace","Enter"] },
    { name: "C8 Enter at start of parent", md: "- parent\n  - kid\n", steps: [["caret","parent",0],"Enter"] },
    { name: "C8b Enter mid parent", md: "- head tail\n  - kid\n", steps: [["caret","head tail",5],"Enter"] },
    { name: "C3 Backspace keeps 2nd para", md: "- first\n\n  second\n", steps: [["caret","first",0],"Backspace"] },
    { name: "C9 two Shift+Tabs", md: "- g\n  - x\n    - k\n  - y\n", steps: [["caret","x",-1],"Shift+Tab",["caret","k",-1],"Shift+Tab"] },
    { name: "C10 Enter over selection", md: "- abcd\n", steps: [["range","abcd",1,3],"Enter"] },
    { name: "C12 parent Enter Tab", md: "- parent\n", steps: [["caret","parent",-1],"Enter","Tab"] },
    { name: "C11 empty bold bullet", md: "- **x**\n- y\n", steps: [["caret","x",-1],"Backspace"] },
    { name: "C7 Delete at end before parent", md: "- a\n- b\n  - kid\n", steps: [["caret","a",-1],"Delete"] },
    { name: "C5 Shift+Enter at start", md: "- text\n- next\n", steps: [["caret","text",0],"Shift+Enter"] },
    { name: "C4 empty task with child", md: "- [ ] x\n  - kid\n", steps: [["caret","x",-1],"Backspace"] },
    { name: "C6 caret reaches saved empty bullet", md: "- a\n-\n- b\n", steps: [["caret","a",-1],"ArrowDown",["type","Z"]] },
    { name: "C13 Enter in quote in bullet", md: "- a\n\n  > quote\n\n  - kid\n", steps: [["caret","quote",2],"Enter"] },
    { name: "C15 bullet text [TODO] typed", md: "- x\n  - kid\n", steps: [["caret","x",0],["type","[TODO"]] },
    { name: "UNDO Enter on parent start", md: "- parent\n  - kid\n", steps: [["caret","parent",0],"Enter","Meta+z"] },
    { name: "UNDO Tab then Shift+Tab", md: "- a\n- b\n", steps: [["caret","b",-1],"Tab","Shift+Tab"] },
  ];
  const out = [];
  for (const port of [6006, 6007]) {
    for (const s of S) {
      const errors = [];
      const onErr = (e) => errors.push(String(e).slice(0, 90));
      page.on("pageerror", onErr);
      await page.goto(`http://localhost:${port}/iframe.html?id=lab-bullets--default&viewMode=story&md=${encodeURIComponent(s.md)}`);
      await page.locator('[data-slate-editor="true"]').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(150);
      let note = "";
      for (const st of s.steps) {
        if (typeof st === "string") { await page.keyboard.press(st); }
        else if (st[0] === "type") { await page.keyboard.type(st[1], { delay: 15 }); }
        else {
          const ok = await page.evaluate(([fn, ...a]) => window.__lab[fn](...a), st);
          if (ok === false) note = ` (caret target missing: ${st[1]})`;
        }
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(60);
      const r = await page.evaluate(() => {
        const lab = window.__lab; const md = lab.save();
        const flat = (ns) => ns.map((n) => n.text !== undefined ? n.text : (n.type === "wikilink" ? `[[${n.target}]]` : flat(n.children).join(""))).join("");
        const shape = (ns, d) => ns.flatMap((n) => {
          if (n.type === "bulleted-list" || n.type === "numbered-list") return n.children.flatMap((i) => shape(i.children, d + 1));
          if (n.type === "blockquote") return shape(n.children, d);
          return [`${d}:${n.type === "paragraph" ? "" : n.type + ":"}${flat(n.children ?? [])}`];
        });
        return { md, live: shape(lab.children(), 0), reload: shape(lab.parse(md), 0) };
      });
      page.off("pageerror", onErr);
      out.push(`${port === 6006 ? "dev  " : "fixed"} ${s.name}${note}\n   md=${JSON.stringify(r.md)}\n   live=${JSON.stringify(r.live)} reload=${JSON.stringify(r.reload)}${errors.length ? "\n   ERRORS=" + JSON.stringify(errors.slice(0,1)) : ""}`);
    }
  }
  return out.join("\n");
}
