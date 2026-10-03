# Moon textures — credits

The textures in this folder come from the **CGI Moon Kit** by Ernie Wright,
NASA's Scientific Visualization Studio (SVS), 2019:
<https://svs.gsfc.nasa.gov/4720>

- Colour: LRO Lunar Reconnaissance Orbiter Camera (LROC) WAC colour mosaic,
  with the poles filled in.
- Relief: LRO Lunar Orbiter Laser Altimeter (LOLA) digital elevation model.

NASA SVS material is public domain (not subject to copyright in the US). NASA
asks for credit: "NASA's Scientific Visualization Studio".

## Files

| File | Size | Source |
| --- | --- | --- |
| `moon-color-4k.webp` | 4096×2048 | `lroc_color_poles_4k.tif` |
| `moon-color-1k.webp` | 1024×512 | `lroc_color_poles_4k.tif`, downscaled |
| `moon-relief-2k.webp` | 2048×1024 | `ldem_16_uint.tif` (16-bit, 5760×2880), downscaled |

Source URLs:

- <https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif>
- <https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif>

Regenerate with `ui/scripts/fetch-moon-textures.sh`.

## Map convention

All three maps are equirectangular (plate carrée) in selenographic
coordinates, centred on longitude 0° (the mean sub-Earth point):

- x = 0 is longitude −180°; x = W/2 is longitude 0°; x = W is +180°.
  East longitude increases to the right.
- y = 0 is latitude +90° (north pole); y = H is latitude −90°.
- So `lon = (x / W) * 360 − 180` and `lat = 90 − (y / H) * 180`.

Checked against known features: Tycho (11°W, 43°S), Mare Crisium (59°E, 17°N),
and Mare Orientale (95°W) all land where the formula puts them.

## Relief encoding

`moon-relief-2k.webp` is relative height only. The 16-bit LOLA heights were
stretched linearly (`-auto-level`) to the full 0–255 range: 0 is the lowest
point on the map, 255 the highest. WebP has no greyscale mode, so the file
stores three equal RGB channels; read any one.
