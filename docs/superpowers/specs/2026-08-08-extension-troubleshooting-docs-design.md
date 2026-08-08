# Browser Extension and Troubleshooting Documentation Design

**Date:** 2026-08-08
**Status:** Approved

## Goal

Make the bundled in-app documentation self-contained for browser-extension setup and move troubleshooting out of Getting Started into a searchable, dedicated guide.

## Current State

Getting Started contains a browser-extension section that only points to `extension/README.md`. That repository-relative reference is not useful to readers consuming the bundled documentation in the app. The same guide also ends with a mixed Quick troubleshooting section covering configuration, TLS, embedded assets, Vite, vault initialization, and the Neovim LSP.

## Information Architecture

Add two registered documentation pages:

- **Troubleshooting** in **Start Here**, after Configuration.
- **Browser Extension** in **Integrations**, after MCP.

The resulting registry order is:

1. Getting Started
2. Configuration
3. Troubleshooting
4. CLI
5. Bases
6. LSP
7. MCP
8. Browser Extension

This order keeps common setup recovery near onboarding and treats browser capture as an optional integration.

## Getting Started Changes

Replace the current browser-extension README reference with a concise link to `/docs/browser-extension`.

Remove the Quick troubleshooting content from Getting Started and replace it with a concise link to `/docs/troubleshooting`. The dedicated page owns that material; Getting Started does not duplicate it.

## Browser Extension Guide

Create `ui/src/docs/content/browser-extension.mdx` as a self-contained user guide. It covers:

- prerequisites: Bun and a running Clepsydra server;
- the archive status and capture endpoints expected by the extension;
- Chromium and Firefox build commands and output directories;
- unpacked installation steps for Chrome, Chromium, Brave, Edge, and Firefox;
- first-time Server URL, tag, notification, and connection-status setup;
- popup and keyboard-shortcut capture flows;
- development watch and reload workflow; and
- extension-specific troubleshooting for server connectivity, failed capture, unsupported pages, and content conflicts.

The page may mirror relevant facts from `extension/README.md`, but it must not require readers to open that file. `extension/README.md` remains the source-tree development guide and is not removed.

## Troubleshooting Guide

Create `ui/src/docs/content/troubleshooting.mdx`. Move the existing Quick troubleshooting cases without changing their operational meaning:

- unresolved `config.toml`;
- TLS auto-certificate failure;
- missing embedded UI assets;
- Vite failing to reach the backend;
- an already initialized vault; and
- Neovim LSP initialization or attachment failure.

Use normal guide headings so each problem is directly searchable and linkable. Preserve links to the LSP guide where deeper diagnostics already exist.

## Registry and Search

Import both MDX components and their raw sources in `ui/src/docs/registry.ts`, create pages in the approved groups, and include them in `DOC_GROUPS`. Existing registry-derived navigation, previous/next links, and search indexing then receive both pages automatically.

Update tests that assert page count, sidebar links, registry order, search results, and MDX rendering. New tests must defend the observable contracts that both slugs resolve and that all eight registered pages render.

## Verification

Run the repository-required gates after implementation:

- UI typecheck;
- UI lint;
- UI test suite; and
- project-wide typecheck, lint, and test commands where separate root commands exist.

Also build or launch the documentation UI and open both new routes to confirm the registered pages render and internal links resolve.

## Non-goals

- Publishing the extension to browser stores.
- Changing extension behavior, configuration, or build output.
- Rewriting unrelated Getting Started sections.
- Removing `extension/README.md`.
