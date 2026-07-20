# Formatting contract

## Geometry

- Default to a `1280 x 720` canvas and `64 px` margins on all sides.
- Keep left/right and top/bottom margins equal within `1 px`.
- Use symmetric component padding; default to `32 px`.
- Text-box and table-cell insets must use one compact token on all four sides: `0, 8, 12, 16, 24, 32 px`. The default table-cell inset is `8 px`; unexplained one-side margins are invalid.
- Keep every object inside the canvas.
- When text declares a backing block, keep all four text-box edges strictly inside that backing's padded inner rectangle. Grow the backing, shorten the copy, or choose another archetype before export.
- Treat unintended overlap, clipping, alignment drift, crowded layouts, and excess wrapping as build failures in both the planned and realized geometry.

## Typography

- Use this point scale: `54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12`.
- Never emit fractional point sizes.
- Select the largest approved size that satisfies width, height, and line-count constraints.
- Reject content below the configured minimum. Recommend shortening or relayout.
- Audit installed typefaces before rendering. Block missing fonts and require an explicit theme change; never silently substitute a fallback.
- Keep single-line banners and titles on one line when the layout requires it.
- Resolve a deck-wide logical master, page archetype, and typography role before laying out slides. A generated logical master is not a claim that a native PowerPoint master was created.
- Give constrained headlines an archetype-specific line and auto-size budget. Shorten the copy before allowing multiple shrink steps or excessive wrapping.
- Preserve paragraph boundaries and use only the deck spacing tokens, normally `0, 6, 12 pt`. Avoid stacked before/after spacing greater than the deck maximum.
- Compare repeated components by master, archetype, family, slot, and declared variant. Headline/body hierarchy may not drift between equivalent instances.
- In repeated `Label — explanation`, `Label: explanation`, or equivalent bullet patterns, keep the label and delimiter in an emphasized native run and the explanation in a separate regular run. Peer explanations must share one style; a label-specific italic or color nuance must not leak into its body.

## Editability

- Render visible text as native PowerPoint text.
- Preserve emphasis through rich-text runs, not separate raster labels.
- Re-run the formatting linter after every named edit. Reject an edit that collapses a mixed-emphasis boundary or makes one peer explanation inherit its label emphasis.
- Use native semantic charts, tables, shapes, and connectors when users may edit them.
- Place triangle center text inside a mathematically inscribed safe zone based on the actual beam thickness; use the usable-space visual center rather than forcing a large box onto the circumcenter.
- Keep regular polygons on one true circumcircle with equal radii, side lengths, and apothems. A square through dodecagon may not be stretched into a non-square bounding field.
- Prefer adjacent labels and intrinsic directional shapes over leader lines. Required relationship connectors must render beneath every endpoint node and text child, terminate under opaque node interiors, and match the destination rim color and weight.
- A focus pattern may accent exactly one peer or one central synthesis outcome. Emphasis changes styling only; it may not change peer dimensions, type roles, or spacing.
- Bind every non-decorative icon to the exact label and a declared semantic concept. The icon name must be allowed by the deck's ontology; for example, `Goal` maps to `target` or `bullseye`.
- Rasterize only photographs, illustrations, and other true visual assets.

## Proof

Require passing plan and rendered-layout lint, an exported PPTX, OOXML audit, rendered previews, and full-size visual review. Use stable object names to map planned objects to actual exported bounds and line counts; missing or ambiguous mappings fail the build.

Run `npm run universal-design` in the repository to exercise seven slides across six unrelated page archetypes, a native table, semantic icons, native paragraph spacing, 21 isolated plan controls, seven exported-OOXML controls, seven hash-bound full-size visual baselines, and single-item 45x icon-card copy stress. Run `npm run emphasis-pattern` to render and audit repeated label/body rich text and reject whole-paragraph emphasis drift or a single leaked explanation. The controls include declaration removal, contract mutation, and custom-contract injection so component, backing, icon, typography, spacing, and rich-text rules cannot be waived by deleting, widening, or rebinding metadata.
