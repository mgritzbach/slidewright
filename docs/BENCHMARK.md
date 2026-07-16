# Slidewright visual fidelity benchmark

Slidewright's controlled exporter-conformance benchmark uses owned, deterministic browser ground truth rather than subjective screenshots. Six references cover an invitation, an information brochure, and a website in horizontal and vertical/mobile compositions. The browser and PowerPoint paths share a machine-readable design manifest; this isolates export fidelity but does not prove independent image understanding or ingestion.

## Existing-deck design-profile benchmark

Run `npm run design-profile` to exercise the source-bound `g22-v1` path on the synthetic, PowerPoint-authored fixture under `fixtures/design-profile/mit-v1/`. The benchmark extracts the source twice and requires byte-identical profiles, adapts the raw OOXML inventory into a clone-only reuse contract, derives a stale-safe named-placeholder edit plan, edits a source copy, and audits the result.

The structural gate covers slide dimensions, theme and visible fonts, integer type sizes, palette, presentation guides, masters, layouts, placeholders, editable logo groups, recurring chrome, and rim/limiter geometry. Four rim/limiter pairs must be exactly symmetric in EMUs; one deliberately unequal 3pt/5pt divider pair is accepted only through its source-SHA and object-hash-bound asymmetry manifest. Pair equality is evaluated in exact EMUs. Eight destructive controls cover guide deletion, a one-EMU side-rail drift, limiter-color drift, logo rename, theme-font drift, undeclared same-slide drift, profile-integrity tampering, and a visibly widened rim whose rendered pixels must fail an exact comparator; every control must be rejected. Microsoft PowerPoint then saves and reopens the derived deck, after which structural state and both slide renders must match exactly. Source-to-derived comparison masks only the declared replacement text.

This benchmark proves bounded reuse inside a clone of the source deck. It does not prove arbitrary structural import, chart/table/diagram reconstruction, or synthesis of unrelated layouts.

Run the complete evidence pipeline:

```powershell
npm run fidelity
```

The command captures references, renders native PowerPoint objects, normalizes groupability, creates real PowerPoint groups, renders the final deck, checks overflow, audits OOXML, produces overlays and difference images, and—when Microsoft PowerPoint is installed—performs a real ungroup/regroup/save/reopen round trip.

## Hard gates

- Every expected visible string is native `a:t` text under its stable object name.
- Zero `p:pic` fallbacks are permitted in the six vector benchmarks.
- Every run must match expected text, typeface, integer point size, bold/italic state, and sRGB color.
- Every object must match its expected geometry and rotation within 1.1 px.
- Shape fills, line colors, and line widths must match.
- Text-box alignment, vertical anchor, line spacing, wrap/fit mode, and insets must match.
- Every slide must contain the expected native `p:grpSp` and no `noGrp` lock.
- `slides_test.py` must report no overflow.
- Each slide must achieve at least 0.95 global normalized image similarity, 0.80 foreground similarity, and 0.40 background-normalized similarity. A generated blank-slide control must fail the combined gate for every fixture.
- Every rendered slide must be reviewed at full size; the metric does not replace human review.

## Evidence outputs

- `outputs/fidelity/slidewright-fidelity-benchmark.pptx`
- `outputs/fidelity/fidelity-audit.json`
- `outputs/fidelity/comparison/visual-fidelity.json`
- `outputs/fidelity/comparison/*-overlay.png`
- `outputs/fidelity/comparison/*-diff.png`
- `outputs/fidelity/powerpoint-group-roundtrip.json` when PowerPoint is installed

Global similarity is `1 - mean_absolute_RGB_error / 255` after resizing the PowerPoint render to the exact browser canvas. Foreground similarity applies the same measure only where either image differs materially from the declared background. Background-normalized similarity divides total error by the stronger foreground signal; a blank background-colored output scores zero on this measure. All three are disclosed and paired with strict object-level structural checks.

## Independent opaque-image benchmark

Run `npm run ingestion` for the anti-circular ingestion proof. Its source is an original 1280×720 raster fixture created outside the repository; the source HTML was deleted before parsing. The committed input is RGB, metadata-free, and hash-named. A fresh no-context parser viewed only that PNG and produced `fixtures/independent/observed-design.json` before any render or score existed.

The renderer receives only that observation JSON. The candidate scorer receives only source and rendered pixels, derives background from source corners, and uses the precommitted 0.95/0.80/0.40 pixel gates plus a blank negative control. An adversarial review later proved that these flat-color metrics alone could pass an image with every text region erased, so edge-v1 adds an independently computed, five-pixel-tolerant edge F1 gate of 0.70. The reconstruction scores 0.79492; a fixture-specific all-text-erased negative control retains excellent flat-color metrics but scores 0.54784 edge F1 and must fail. The OOXML auditor separately requires 13 native text objects, 10 native shapes, zero pictures/media, zero grouping locks, exact observation-record text/run formatting, and no embedded source raster. Provenance validation uses checkout-relative access records, freezes the input, parser-output, PPTX, and rendered-image hashes, and statically rejects fixture copy hard-coded into implementation files.

The current release run passes at 0.95102 global, 0.93510 foreground, 0.89922 background-normalized, and 0.79492 edge F1. Full-size review confirms a recognizable editable reconstruction while also showing expected font-metric and text-placement deviations; this benchmark proves independent ingestion, not pixel-perfect font identification.

## Golden-template preservation benchmark

Run `npm run template` to exercise the separate existing-deck path on the MIT fixture in `fixtures/template/mit-v1/`. Its edit plan pins the source SHA-256 and authorizes only exact before/after copy changes in two uniquely named native placeholders on slide 1.

The package audit requires identical part inventory and relationship tuples; only `ppt/slides/slide1.xml` may change. All master, layout, theme, and preserve-only slide parts remain byte-identical, and the complete target slide must be byte-identical after normalizing only the authorized `a:t` values. Render comparison requires exact pixels outside the edited placeholder masks and an exact preserve-only slide. Microsoft PowerPoint must serialize a distinct file with `SaveAs`, reopen it, retain the expected master/layout/placeholders/footer/slide number, and rerender both slides at at least 0.999 similarity. Five destructive controls must reject protected-theme mutation, preserve-only-slide mutation, same-slide non-target mutation, an unexpected package part, and stale before-text.

The current fixture retains the same 39-part inventory with 38 byte-identical parts and one authorized changed slide part, plus 36 identical relationship tuples, one master, 11 layouts, one theme, zero pictures, 1.0 outside-mask similarity, an exact preserve-only slide, and 1.0 similarity on both post-PowerPoint renders. This establishes a surgical copy-edit path only; it does not prove arbitrary structural import or complex-object preservation.
## Fine-grained named-iteration benchmark

Run `npm run iteration` to exercise six independent `c16-v1` edits: single-run text, run-level bold, color, position, a semantic horizontal native-shape chart value, and a named two-column gap. Each manifest pins the full baseline-plan content hash; the editor derives the exact changed-object closure and rejects stale hashes, missing targets, invalid values, no-ops, caller allowlist expansion, inventory changes, and collateral drift.

Every generated PPTX is normalized deterministically: relationship IDs and their owner references are sorted, core timestamps and creation IDs are fixed from stable inputs, and ZIP order and metadata are fixed. The repeat baseline must therefore be byte-identical. Whole-package comparison requires the same part inventory and semantic relationship tuples, rejects dangling references, hashes every named top-level object, and permits changes only inside editor-derived named-object subtrees. Native-shape charts store hash-checked canonical data in PowerPoint alternative text with `officeChart:false`; the chart edit must change both the root payload and the corresponding mark.

The render gate derives masks from exported OOXML geometry and requires exactly zero changed pixels outside those masks. Eight destructive controls cover unauthorized objects, relationship targets, dangling references, masters, extra parts, chart metadata, creation IDs, and off-mask pixels. On Windows, PowerPoint opens, saves, reopens, and preserves all named-shape properties?including semantic descriptions?for the baseline and all six variants; every post-PowerPoint render must be an exact pixel match.
