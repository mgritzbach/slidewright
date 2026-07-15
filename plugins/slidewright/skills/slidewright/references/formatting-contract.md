# Formatting contract

## Geometry

- Default to a `1280 x 720` canvas and `64 px` margins on all sides.
- Keep left/right and top/bottom margins equal within `1 px`.
- Use symmetric component padding; default to `32 px`.
- Keep every object inside the canvas.
- Treat unintended overlap, clipping, alignment drift, crowded layouts, and excess wrapping as build failures in both the planned and realized geometry.

## Typography

- Use this point scale: `54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12`.
- Never emit fractional point sizes.
- Select the largest approved size that satisfies width, height, and line-count constraints.
- Reject content below the configured minimum. Recommend shortening or relayout.
- Audit installed typefaces before rendering. Block missing fonts and require an explicit theme change; never silently substitute a fallback.
- Keep single-line banners and titles on one line when the layout requires it.

## Editability

- Render visible text as native PowerPoint text.
- Preserve emphasis through rich-text runs, not separate raster labels.
- Use native semantic charts, tables, shapes, and connectors when users may edit them.
- Rasterize only photographs, illustrations, and other true visual assets.

## Proof

Require passing plan and rendered-layout lint, an exported PPTX, OOXML audit, rendered previews, and full-size visual review. Use stable object names to map planned objects to actual exported bounds and line counts; missing or ambiguous mappings fail the build.
