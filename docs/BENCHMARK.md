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
