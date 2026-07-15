# Slidewright binary goal register

Status is binary: `1` means the stated evidence exists and was checked; `0` means it does not. Progress notes never change the binary definition.

| ID | Goal | Status | Required evidence |
| --- | --- | ---: | --- |
| G01 | Valid repo-local Codex plugin and skill | 1 | Plugin validator and skill validator both pass |
| G02 | Deterministic layout compiler | 1 | Unit tests prove stable output from the same input |
| G03 | Symmetric margins and padding | 1 | Linter fixtures pass valid cases and reject asymmetric cases |
| G04 | Conventional integer font sizing | 1 | Autosizer tests plus exported OOXML font-size audit |
| G05 | Native editable text and shapes | 1 | OOXML audit finds native text nodes and no text-as-image fallback |
| G06 | Mixed bold and regular formatting | 1 | Exported PPTX contains both bold and regular runs in one text object |
| G07 | No overflow or clipping in demo | 1 | Plan lint, renderer layout export, slide test, and full-size visual inspection |
| G08 | Runnable judge path | 1 | Fresh-clone setup and demo commands succeed from documented instructions |
| G09 | Build Week submission package | 0 | Public/private judge repo access, <3 minute public demo, description, screenshots, testing instructions, and `/feedback` session ID |
| G10 | Template-preserving edit path | 0 | Golden-file test on a user-provided or licensed template with explicit deviation log |
| G11 | Owned controlled exporter-conformance benchmark | 1 | Invite, brochure, and website manifest drives six browser/PPT reference pairs |
| G12 | Object-level formatting fidelity | 1 | Final OOXML audit matches text, typeface, integer size, emphasis, color, geometry, rotation, line style, alignment, line spacing, fit mode, and insets for every named object |
| G13 | Native group integrity | 1 | Six expected `p:grpSp` groups exist, group locks are removed, and no raster fallback exists |
| G14 | Published visual-fidelity bar | 1 | Every fixture passes global, foreground, and background-normalized image gates plus exact object geometry |
| G15 | Horizontal and vertical reflow proof | 1 | Every design family has independent horizontal and vertical/mobile composition |
| G16 | Editable horizontal and vertical graphics | 1 | Native timeline, horizontal bars, and vertical bars pass structural audit |
| G17 | Copy-mutation resilience | 1 | -25% and +25% copy fixtures relayout without clipping or sub-minimum type |
| G18 | One-command evidence bundle | 1 | `npm run fidelity` emits references, PPTX, renders, audit, comparisons, and scorecard |
| G19 | Real PowerPoint ungroup/regroup round trip | 1 | PowerPoint opens, ungroups, regroups, saves, reopens, and preserves member count plus native text |
| G20 | Missing-font and dense-content repair | 1 | Fixtures fail or relayout with actionable diagnostics and never silently emit tiny text |
| G21 | Independent image-to-PowerPoint ingestion | 1 | A design image not generated from the output manifest is parsed, reconstructed, and scored without shared geometry input |

## Complaint-derived goal register

These goals come from the public complaint inventory in `docs/COMPLAINT_LEDGER.md`. Status remains binary and deliberately conservative.

| ID | Goal | Status | Required evidence |
| --- | --- | ---: | --- |
| C01 | Capability preflight and actionable recovery | 1 | One command detects missing skill, runtime, renderer, PowerPoint, and fonts and returns exact supported remediation |
| C02 | Discoverable self-contained install across Codex surfaces | 0 | Fresh Desktop, CLI, and VS Code checks find or install Slidewright without marketplace UI assumptions |
| C03 | Reliable clean-host runtime bootstrap | 0 | Windows, macOS, Linux, and WSL clean hosts resolve a supported runtime or fail once with a tested fallback; no pinned-asset 404 |
| C04 | Repair-free PowerPoint output | 0 | 20+ release fixtures pass ZIP, relationships/content-types, Open XML validation, and real PowerPoint open/save without repair or removed content |
| C05 | Verified delivery with no dead links | 1 | Delivery command verifies existence, nonzero size, ZIP integrity, canonical path, and link target before reporting success |
| C06 | Preview-independent handoff | 1 | Each delivery includes PPTX, per-slide PNGs, montage/PDF, manifest, and external-open instructions verified from output and workspace paths |
| C07 | Native editable visible text | 1 | Controlled six-slide audit finds every expected string in native named text objects with zero pictures |
| C08 | Complete semantic object coverage | 0 | Expected shapes, groups, charts, tables, connectors, images, notes, and hierarchy are counted and matched; undeclared flattening fails |
| C09 | No text-as-image or full-slide raster fallback | 1 | Controlled benchmark has zero `p:pic` objects and 129 native editable elements |
| C10 | Template, master, layout, and brand preservation | 0 | Licensed golden templates retain masters, layouts, placeholders, theme relationships, palette, spacing, and chrome with explicit deviation report |
| C11 | Font and advanced-format integrity | 0 | Missing/substituted fonts fail visibly; licensed embedding and complex template/font fixtures pass PowerPoint round trips |
| C12 | Prompt-robust workflow | 0 | Minimal, verbose, conflicting, and adversarial prompt matrix cannot bypass compile/lint/render/audit or degrade below quality gates |
| C13 | Professional visual quality | 0 | Blind expert review and five target users meet defined first-open acceptance and cleanup-time thresholds across 20+ independent designs |
| C14 | Automated geometric and readability defects | 0 | Overlap, overflow, clipping, contrast, alignment, wrapping, crowded layout, and chart-readability checks have positive and negative fixtures |
| C15 | Dense-content and copy-mutation resilience | 0 | -25%, +25%, translation expansion, and dense-copy fixtures relayout without clipping or sub-minimum type |
| C16 | Stable fine-grained iteration | 0 | Named-object edits for text, bold, color, position, chart, and layout preserve unrelated object hashes and pass rerender comparison |
| C17 | Structural existing-PPTX ingestion | 0 | Import retains slide/master hierarchy, text runs, tables, diagrams, charts, notes, and semantic reading order on licensed decks |
| C18 | Native readable charts, tables, and diagrams | 0 | Horizontal/vertical charts, tables, connectors, and diagrams remain editable and pass mutation, readability, and OOXML audits |
| C19 | Cross-suite interoperability | 0 | Published matrix proves open/import behavior in PowerPoint Windows/macOS, Google Slides, Keynote, LibreOffice, and Canva |
| C20 | Transparent dependencies and platform behavior | 1 | No silent install or renderer switch; lockfile, runtime version, renderer, font requirements, and supported matrix are emitted per build |
| C21 | Optional direct-PowerPoint editing fallback | 0 | Windows adapter can open, select, edit, group/ungroup, save, and verify while generation remains functional without computer-use tooling |
| C22 | Public reproducible quality evidence | 0 | Committed public benchmark, exact commands, negative controls, versioned scorecards, CI artifacts, and a fresh-machine replication report |

## Evidence register

Append dated evidence here. Do not replace the goal definitions with looser substitutes.

- 2026-07-14: Repository initialized; plugin and skill scaffolds created.
- 2026-07-14: Plugin validator and skill validator passed.
- 2026-07-14: Node test suite passed 8/8, including determinism, autosizing, rich text, symmetric geometry, and negative diagnostics.
- 2026-07-14: Demo compiled to three slides with zero lint warnings and zero lint errors.
- 2026-07-14: `slides_test.py` reported no overflow; all three LibreOffice-rendered slides were inspected at full size with no clipping, wrapping, or unintended overlap.
- 2026-07-14: OOXML audit passed with 18 native text nodes, 10 bold runs, 8 regular runs, 2 mixed-emphasis paragraphs, no fractional font sizes, and no sizes outside the approved scale.
- 2026-07-14: A clean temporary copy with no `.git`, `node_modules`, or `outputs` completed `npm run demo` end to end in 18.7 seconds.
- 2026-07-15: Six owned browser references and six native PowerPoint reconstructions completed the one-command fidelity benchmark.
- 2026-07-15: Forensic audit passed 129/129 named objects, six native groups, zero pictures, exact text/run formatting, geometry, rotation, lines, alignment, line spacing, fit mode, and insets.
- 2026-07-15: Visual comparison passed all six slides: 0.97528 global average, 0.91844 foreground average, and 0.72427 background-normalized average. The blank-slide negative control was rejected for all six. Every pair was inspected at full size; two review findings were fixed and rerun.
- 2026-07-15: `slides_test.py` passed with no overflow on the grouped benchmark deck.
- 2026-07-15: Microsoft PowerPoint ungroup/regroup/save/reopen round trip preserved all 16 slide-1 children and eight native text items.
- 2026-07-15: Final regression passed 11/11 Node tests, demo compile/lint/render/audit, benchmark overflow test, skill validation, and plugin validation; all nine rendered demo and benchmark slides were reviewed at full size.
- 2026-07-15: Public complaint sweep deduplicated direct Codex/OpenAI issue reports, Reddit complaints, official limitations, and adjacent editable-PPTX workflow failures into C01-C22. At sweep time, only C07 and C09 had the named proof.
- 2026-07-15: Capability preflight passed the real runtime and produced explicit availability plus remediation for the skill, Node, Python, artifact runtime, renderer, fonts, PowerPoint, and LibreOffice. Negative unit fixtures independently removed every required capability and confirmed a blocking result with actionable remediation; optional PowerPoint absence remained visible without disabling generation.
- 2026-07-15: Delivery verification passed the six-slide benchmark at its canonical path with 32,617 bytes, SHA-256 `263ec29cda9e91bb79e3735fe30e45b0fed3f0f11c4411613e6f244fb68e8214`, six slides, all required PPTX package parts, valid ZIP integrity, and six preview paths. Negative unit fixtures rejected missing, empty, corrupt, and wrong-extension artifacts. The one-command fidelity pipeline now runs both preflight and delivery verification.
- 2026-07-15: The same delivery emitted six matching full-slide PNGs, a montage, a machine-readable manifest, and host-specific external-open instructions. Bundle-required verification rejects missing previews, montage, or instructions.
- 2026-07-15: Dependency transparency proof added a portable lockfile, explicit Codex runtime selection, artifact-tool and renderer versions, required-font reporting, and a conservative platform matrix. A fresh temporary checkout completed clean `npm ci`, 17/17 tests, demo compile/lint with zero warnings, skill validation, and plugin validation without inheriting workspace `node_modules`.
- 2026-07-15: Whole-word -25% and +25% copy fixtures both compiled and linted with zero warnings, rendered as three editable slides each, passed `slides_test.py`, preserved approved whole-point type and mixed emphasis, passed OOXML audit and bundle verification, and were inspected individually at full size with no clipping, unintended overlap, or sub-minimum body type.
- 2026-07-15: Consolidated `npm run release:check` passed preflight, 20/20 unit tests, demo compile/lint/render/audit, the full six-slide fidelity benchmark, real PowerPoint group round trip, verified delivery bundle, and both mutation builds in 167 seconds. All 15 current demo, fidelity, and mutation renders were then inspected individually at full size.
- 2026-07-15: Missing-font audit found and removed a real silent-substitution risk in the demo, which now explicitly uses installed Arial. The renderer itself blocks unresolved fonts and returns an exact install-or-explicit-fallback remedy; the negative control applied no substitution and emitted no PPTX.
- 2026-07-15: A 4x dense-copy fixture produced ten actionable `SW004` fit failures. Every text object remained at or above its configured minimum (12pt eyebrow, 16pt body/callout, 28pt title), the renderer refused export, and no invalid or tiny-text PPTX was created.
- 2026-07-15: Updated `npm run release:check` passed 24/24 tests, font-audited demo render/audit, six-slide fidelity plus PowerPoint round trip, both mutation builds, and both repair negative controls in 168 seconds. All 15 regenerated slides were inspected individually at full size.
- 2026-07-15: Independent opaque-image ingestion passed on the first pixel-scored run after schema/exporter corrections and without changing precommitted thresholds. A fresh no-context parser viewed only metadata-free SHA-256 fixture `7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png`; the quarantined HTML source had already been deleted. The frozen observation produced 13 native text objects and 10 native shapes with zero pictures/media, no embedded source raster, no grouping locks, no overflow, and verified delivery. Pixel scoring passed at 0.95102 global, 0.93510 foreground, and 0.89922 background-normalized similarity; the blank control failed. Source, reconstruction, overlay, and difference image were inspected at full size and visible font-metric/placement deviations were retained as disclosed limitations.
- 2026-07-15: Standalone skill validation in a fresh workspace with no inherited `node_modules` completed the skill-local runtime bootstrap, preflight, compile, font audit, lint, native render, and OOXML audit. The generated one-slide PPTX contained five native text nodes, zero pictures, approved whole-point type, and mixed bold/regular runs. Local Codex CLI 0.118.0 lacks the current documented `codex plugin` command, so CLI installation remains uncredited under C02 while desktop-marketplace and direct-skill distribution are packaged.
- 2026-07-15: Consolidated `npm run release:check` passed preflight, 28/28 tests, three-slide demo compile/font/lint/render/audit, six-slide controlled fidelity and real PowerPoint ungroup/regroup round trip, both copy-mutation builds, missing-font and dense-copy negative controls, independent image ingestion, and verified delivery in 212.6 seconds. All 16 regenerated demo, fidelity, mutation, and ingestion slides were then opened and inspected individually at full size.
- 2026-07-15: Independent release review found and blocked three overclaims. The standalone loader was changed to resolve `@oai/artifact-tool` from the bootstrapped target workspace; a copied skill and sibling workspace outside the repository then completed bootstrap, preflight, compile, render, and OOXML audit with zero pictures. Parser access evidence was converted from machine-specific absolute paths to checkout-relative paths and the complete ingestion run passed from the portable verifier. Finally, edge-v1 added a 0.70 content-sensitive gate: the reconstruction passed at 0.79492 edge F1, while an all-text-erased control that still scored 0.97223/0.96039/0.94285 on the three flat-color metrics failed at 0.54784 edge F1.
- Remaining binary blockers: submission package (G09) and template preservation (G10).
