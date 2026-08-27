# clepsydra.nvim

Neovim companion plugin for a Clepsydra vault. Install via a lazy.nvim `dir`
spec pointed at this directory. Full docs — prerequisites, options, commands,
and health checks — live at the app's `/docs/neovim` page.

Run the test suite with:

```
nvim --headless -l nvim/tests/run.lua
```

Note: for manual `:checkhealth` runs outside a plugin manager, add the plugin with `-c 'lua vim.opt.rtp:prepend("/path/to/clepsydra/nvim")'` — `--cmd 'set rtp+=…'` runs too early for health-module discovery.
