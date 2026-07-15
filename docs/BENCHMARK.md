# Slidewright visual fidelity benchmark

Slidewright's controlled exporter-conformance benchmark uses owned, deterministic browser ground truth rather than subjective screenshots. Six references cover an invitation, an information brochure, and a website in horizontal and vertical/mobile compositions. The browser and PowerPoint paths share a machine-readable design manifest; this isolates export fidelity but does not prove independent image understanding or ingestion.

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
