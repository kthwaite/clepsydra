# LSP server (`clep lsp`)

`clep lsp` is a standalone language server on stdio. It opens its own
read-only vault state — a private, in-memory index built once at startup and
kept fresh by its own file watcher — and never writes vault files. Editing a
vault in Neovim (or Helix, or any LSP client) gets completion, hover
previews, go-to-definition, link diagnostics, project-wide rename, and
references.

Because it's read-only and keeps its index in memory rather than talking to
a running server, `clep lsp` is independent of `clep serve`: run both at once
against the same vault. `clep serve` is what powers the web UI and owns all
writes (including the folder-follows-metadata reconcile — see "Save
behavior" below); `clep lsp` is a second, disposable reader that Neovim
starts and stops on its own.

Design notes: docs/plans/archive/2026-02-15-lsp-design.md (pre-dates the
standalone split described here).

## Setup (Neovim 0.11+)

1. Put `clep` on `PATH` (`cargo install --path .` or symlink the build).
2. Register the server in `init.lua`:

   ```lua
   vim.lsp.config['clepsydra'] = {
     cmd = { 'clep', 'lsp' },
     filetypes = { 'markdown' },
     -- Attach only inside a vault: a `.clepsydra` directory marks the root.
     root_dir = function(bufnr, on_dir)
       local root = vim.fs.root(bufnr, '.clepsydra')
       if root then on_dir(root) end
     end,
   }
   vim.lsp.enable('clepsydra')
   ```

On Neovim 0.10, use `vim.lsp.start` in a `FileType` autocmd instead:

```lua
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'markdown',
  callback = function(args)
    local root = vim.fs.root(args.buf, '.clepsydra')
    if not root then return end
    vim.lsp.start({
      name = 'clepsydra',
      cmd = { 'clep', 'lsp' },
      root_dir = root,
    })
  end,
})
```

The server speaks UTF-8 positions only (`PositionEncodingKind::UTF8`);
Neovim negotiates this automatically. Helix works with the equivalent
`languages.toml` entry (`command = "clep"`, `args = ["lsp"]`).

Root resolution (in order): the workspace folder(s) the editor sends (or the
deprecated `rootUri` if that's all it sends), each searched up its ancestor
chain for a `.clepsydra` directory; if none carries the marker, the server
falls back to the same app-config lookup as `clep serve`/`clep new`
(`./config.toml` → `$XDG_CONFIG_HOME/clepsydra/config.toml` →
`$HOME/.config/clepsydra/config.toml`), reading `[vault].root` from whichever
resolves. Because resolution keys off the workspace root the editor hands it,
multiple vaults just work: open each vault as its own Neovim workspace and
every instance of `clep lsp` resolves its own root independently — no
`cmd_cwd` juggling needed.

## Capabilities

| Capability | What it does |
| --- | --- |
| Completion | `[[` completes page links by canonical name; `#` completes tags from the vault vocabulary; inside `+++` frontmatter fences, property keys and quoted string values complete against declared base properties |
| Hover | Preview of the linked page: title, path, first lines of the body; unresolved links say so |
| Go to definition | Jump from a wikilink under the cursor to the target page |
| Diagnostics | Unresolved wikilinks; ambiguous links (multiple candidate pages); frontmatter property type warnings, checked against each base whose filter matches the page |
| Code actions | `Create page: <target>` for an unresolved link; `Resolve to: <path>` per candidate for an ambiguous one |
| Rename | Rename a page from its title line or from any link to it: one workspace edit updates the frontmatter title, renames the file on disk, and rewrites every referring wikilink |
| References | Every wikilink to the page under the cursor, vault-wide |
| Document symbols | Heading outline of the open page |
| Workspace symbols | Page lookup by title across the vault |
| Code lens | An `N references` lens on each page, resolving to find-references |

## Save behavior

On save, `did_save` reindexes the page in the LSP's own in-memory index —
links re-resolve and diagnostics refresh immediately — but it does **not**
reconcile folder placement: the standalone LSP is read-only by design (ADR
0001), so it never moves a file even if the saved frontmatter's `kind`/
`project` now disagrees with the folder it's in.

Folder-follows-metadata healing is `clep serve`'s job (ADR 0001 layer 2): its
own file watcher sees the same save and, after reindexing its batch, runs
the reconcile pass that moves a drifted page to its projected folder. If
`clep serve` is running alongside `clep lsp`, that move lands almost
immediately — `clep lsp`'s independent watcher then notices the resulting
remove/add pair, reindexes, and (for any open buffer at the old path) logs
`clepsydra: <old> moved to <new> (folder follows kind/project); reopen the
file` to `:LspLog`. The buffer itself keeps pointing at the old path; reopen
the file at its new location. If `clep serve` is *not* running, drift is
left alone until the next `clep serve` startup, which sweeps the whole vault
and heals it then.

## Troubleshooting

- **`initialize` fails / client attaches then immediately stops** — the
  server couldn't resolve a vault root: no ancestor of the workspace folder
  has a `.clepsydra` directory, and no `config.toml` resolved either. Check
  `:LspLog` for the error, and run `clep config path --trace` from the same
  directory Neovim was started in to see which app config (if any) would be
  selected.
- **No completions inside `[[ ]]`** — completion is prefix-filtered on
  canonical names; confirm the workspace root actually contains the vault
  (see the root-resolution order above) and that the page you're linking to
  has been indexed (it's on disk under that root).
- **Renamed/moved file, buffer went stale** — expected for now; see "Save
  behavior" above. Automatic buffer retargeting via
  `workspace/didRenameFiles` is a known follow-up.
- **Diagnostics or rename don't reflect a very recent external edit** — the
  LSP's index updates from its own watcher (roughly every 500ms, debounced)
  or on `did_save` for the open buffer; an edit from another process needs
  one debounce cycle to show up.
