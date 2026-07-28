# Figures and recipes

## Quick figure

Press `Cmd/Ctrl+Shift+S` to export the current view immediately as a 2400 ×
1800 px, 300 DPI, white-background PNG.

The export uses the current orientation, a fitted camera, publication lighting,
explicit sRGB output, and cell-clipped periodic geometry. Repeated-cell views
retain continuity between displayed neighbors. Detail and supersampling adapt
to output size and graphics support.

## Export inspector

Choose **Export** to open one sheet with:

- landscape, square, and wide presets
- exact width and height from 1–8,192 px per dimension, subject to a
  12-megapixel total and the device's WebGL limits
- DPI metadata
- PNG or TIFF
- white or transparent background
- orthographic or perspective projection
- labels for selected atoms
- an element legend
- an orthographic scale bar

DPI does not add pixels. Set pixel dimensions for the final journal or slide
layout, then set the matching DPI metadata.

PNG and TIFF are the molecular figure formats. CSV, SVG, and vector PDF are
available for plots.

## Figure recipes

A recipe records the source, frame identity and fingerprint, camera, selection,
periodic display, representation, vectors, annotations, and output settings.
Save it with a `.pqfigure.json` or `.pqv.json` suffix.

Recipes contain source paths, not molecular coordinates, and are not
self-contained. Saved recipes normally record local paths. If a recipe uses a
relative path, it is resolved from the recipe directory. Reopening checks that
the source, frame identity, and rendered frame content still match.

Recipes cannot be saved from a temporary browser upload or an in-memory ASE
object because those sources do not have a reusable local path.

Open a recipe interactively:

```bash
pqviewer view.pqfigure.json
```

## Headless rendering

Install the rendering extra and Chromium once:

```bash
python -m pip install '.[render]'
python -m playwright install chromium
```

Render the saved view:

```bash
pqviewer render view.pqfigure.json -o figure.tiff
```

Override selected output settings without changing the recipe:

```bash
pqviewer render view.pqfigure.json \
  -o figure.png \
  --width 3000 \
  --height 2000 \
  --dpi 300 \
  --transparent
```

The output suffix must be `.png`, `.tif`, or `.tiff`. If `--format` is supplied,
it must agree with the suffix.

Interactive viewing and publication export use separate rendering paths. The
interactive renderer prioritizes responsive inspection, while figure and
headless export use the publication renderer at the requested output size.
Saved recipes keep the view reproducible and validate their source, but graphics
drivers, Chromium versions, and operating systems can produce small pixel
differences. Interactive molecular surfaces are not currently available through
the publication renderer; choose another preset before exporting a figure.
