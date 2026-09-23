# Clepsydra icon

The drop-dial mark: a water drop with clock hands.

Palette: cobalt `#1747E6` (field), bone `#F6F1E6` (drop), ink `#0E1A3A` (hands).

## Sources

- `clepsydra-icon.svg` is the master. The field runs to the edges, and the glyph sits inside the PWA maskable 80% safe circle.
- `clepsydra-icon-macos.svg` is an 824 px tile on the 1024 grid (100 px margin). The glyph is scaled to 0.805.
- `ui/public/favicon.svg` is a rounded tile. It is also the source for the PWA "any" icons and the extension icon.
- `ui/src/editor/elements/WikilinkIcon.tsx` is the outline version, used inline for wikilinks.

## Regenerating rasters

Run from the repo root with Inkscape 1.4+.

```sh
inkscape design/icon/clepsydra-icon.svg -w 512 -h 512 -o ui/public/pwa-maskable-512.png
inkscape design/icon/clepsydra-icon.svg -w 180 -h 180 -o ui/public/apple-touch-icon.png
inkscape ui/public/favicon.svg -w 512 -h 512 -o ui/public/pwa-512.png
inkscape ui/public/favicon.svg -w 192 -h 192 -o ui/public/pwa-192.png
inkscape ui/public/favicon.svg -w 128 -h 128 -o extension/src/public/icons/icon-128.png

mkdir -p /tmp/clepsydra.iconset
for s in 16 32 128 256 512; do
  inkscape design/icon/clepsydra-icon-macos.svg -w $s -h $s -o /tmp/clepsydra.iconset/icon_${s}x${s}.png
  inkscape design/icon/clepsydra-icon-macos.svg -w $((s*2)) -h $((s*2)) -o /tmp/clepsydra.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns /tmp/clepsydra.iconset -o crates/clep/assets/clepsydra.icns
```

`crates/clep/assets/clepsydra.icns` is embedded in the `clep` binary. It becomes the icon of the macOS URL-handler applet (`macos_url_handler.rs`).
