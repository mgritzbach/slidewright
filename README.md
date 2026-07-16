# Slidewright

[![Core CI](https://github.com/mgritzbach/slidewright/actions/workflows/ci.yml/badge.svg)](https://github.com/mgritzbach/slidewright/actions/workflows/ci.yml)

**Editable decks, engineered rather than approximated.**

Slidewright is a Codex plugin and deterministic layout compiler that turns ideas and structured content into native, editable PowerPoint decks without the usual formatting damage. It treats slide generation like a build pipeline: compile constraints, render native objects, lint the result, inspect the exported OOXML, and retain evidence.

The Build Week entry targets **Work & Productivity**. The initial vertical slice proves the hardest, most reusable behaviors:

- equal outer margins and symmetric internal padding;
- automatic text fitting that selects conventional integer point sizes;
- native editable text and shapes;
- mixed bold and regular text runs;
- overflow, clipping, and formatting lint rules;
- machine-readable QA evidence for every build.

## Quick start

### Install in Codex

Add the public Slidewright marketplace and install the plugin:

```powershell
codex plugin marketplace add mgritzbach/slidewright
codex plugin add slidewright@slidewright
```

Restart the Codex desktop app and begin a new task so the bundled `$slidewright` skill is loaded. The plugin is self-contained under `plugins/slidewright/`; advanced users can also copy `plugins/slidewright/skills/slidewright/` directly into their Codex skills directory.

### Develop locally

Requirements: Node.js 20+, Python 3.11+, and a Codex environment with the bundled `@oai/artifact-tool` presentation runtime.

```powershell
python -m pip install -r requirements-ci.txt
npm run setup:runtime
npm run preflight
npm test
npm run demo:compile
npm run demo:lint
```

To execute the full artifact-level demo, run:

```powershell
npm run demo
```

`npm run setup:runtime` discovers the installed Codex presentation runtime rather than relying on a version-specific local path.

The installed skill has the same self-contained bootstrap as `node <slidewright-skill>/scripts/slidewright.mjs bootstrap`; it links the already bundled Codex runtime into the active workspace and does not download or silently switch renderers. Codex CLI 0.118.0 on the current Windows test host does not yet expose the documented `codex plugin` subcommand; use the desktop Plugins directory or copy the skill folder directly on older CLI builds.

Outputs are written to `outputs/demo/` and include the editable PPTX, rendered previews, compiled layout plan, and QA reports.

To prove that ordinary edits do not collapse the layout, run the whole-word copy mutation benchmark:

```powershell
npm run mutation
```

It rebuilds -25% and +25% copy variants, then lints, renders, audits, overflow-tests, bundles, and verifies both decks.

Missing-font and extreme-density negative controls are reproducible with:

```powershell
npm run repair
```

The command proves that missing fonts and copy that cannot fit above the configured type floor block export with actionable diagnostics; no silent fallback or tiny-text PPTX is emitted.

To run the two-phase geometric and readability defect matrix, including a real Microsoft PowerPoint text-bound check on Windows, run:

```powershell
npm run defects
```

The matrix covers canvas and parent clipping, text overflow, unintended overlap and occlusion, contrast, compiler-declared alignment, wrapping, crowding, and bounded chart-component readability. It repeats every isolated negative three times, rejects a false fit only visible after layout export, deletes an intentionally clipped PowerPoint after the real application rejects it, and writes a content-addressed scorecard under `outputs/defects/`. Chart checks derive label, mark, collision, bounds, contrast, and orientation results from rendered native-shape child geometry; they do not claim native PowerPoint chart export.

## Template-preserving edit benchmark

`npm run template` exercises the deliberately narrow existing-deck path on an MIT-licensed, PowerPoint-authored golden fixture. The editor changes only declared text nodes in two uniquely named native placeholders and refuses stale source hashes, unexpected source text, or ambiguous shapes. The audit proves that every other package part, relationship, master, layout, theme, and preserve-only slide is unchanged, then PowerPoint serializes a new file with `SaveAs`, opens it again, and rerenders the result. Five destructive controls prove that theme drift, control-slide drift, same-slide non-target drift, extra package parts, and stale edit contracts are rejected.

This is evidence for exact named-placeholder copy edits, not a claim of general PowerPoint import or arbitrary deck restructuring. The generated deviation log is written to `outputs/template/deviation-log.json`.

## Optional direct PowerPoint adapter

On Windows hosts with Microsoft PowerPoint installed, run:

```powershell
npm run powerpoint:adapter
```

The bounded adapter opens a generated deck in PowerPoint, ungroups a named native group, selects and verifies one named text shape, changes its native text and bold state, regroups the same 16 members, saves, reopens, verifies the edit, and records before/after hashes. It also runs a negative control proving that an unavailable PowerPoint adapter leaves normal PPTX generation and delivery verification enabled. The adapter is optional and Windows-only; generation does not depend on PowerPoint or computer-use tooling.

## Fine-grained named iteration

Use a stale-safe `c16-v1` manifest to update one named object or one bounded layout contract without rebuilding unrelated slide content:

```powershell
node plugins/slidewright/skills/slidewright/scripts/slidewright.mjs iterate outputs/demo/plan.json --manifest edit.json --out outputs/demo/updated-plan.json
```

The editor derives its own exact change closure; a caller-provided allowlist cannot broaden it. Version 1 supports single-run text, run-level bold, fill/text color, position, a semantic native-shape chart value plus its mark, and the gap in a named two-column layout. Always lint, render, audit, and compare the updated plan before delivery. The C16 benchmark exercises every mutation independently, rejects stale/no-op/collateral changes, and checks a real PowerPoint save/reopen. Native-shape chart components remain distinct from Office `c:chart` objects.

Run the complete evidence bundle with `npm run iteration`.

## Existing-deck design profiles

Slidewright can extract a deterministic, source-bound design profile from a native PowerPoint deck and derive a safe copy-only edit plan that reuses its slide size, fonts, palette, guides, master/layout binding, logos, recurring chrome, placeholders, and exact rim/limiter contracts:

```powershell
node plugins/slidewright/skills/slidewright/scripts/slidewright.mjs profile source.pptx --out profile.json
node plugins/slidewright/skills/slidewright/scripts/slidewright.mjs derive profile.json --intent design-intent.json --content content-spec.json --out edit-plan.json
npm run design-profile
```

The verified `g22-v1` policy is deliberately clone-only: it edits declared native placeholder text inside a copy of the source deck and preserves undeclared objects. It does not claim arbitrary structural import or unrestricted generation from someone else's template. The benchmark uses a synthetic PowerPoint-authored fixture, exact-EMU geometry audits, eight destructive controls—including a rendered rim-geometry mutation—real PowerPoint save/reopen, and full-size visual review. Read the [design-profile contract](plugins/slidewright/skills/slidewright/references/design-profile.md) before applying it to an existing deck.


## Feedback-safe layout contracts

Run `npm run feedback-contract` to exercise the five hard layout rules recovered from the `Locate event info` failure analysis:

- native text boxes and reserved media regions may never intersect;
- a headline uses the complete safe width unless an actual center or two-thirds structural split reserves space;
- a background or title band grows to the realized text height plus symmetric padding;
- every declared topic owns an explicit divider and substantive slide in manifest order;
- empty paragraphs are removed before fitting, including blank bullets inherited from a real PowerPoint master.

The benchmark builds 34 editable slides for the exact 17-topic outline, repeats compilation three times, runs nine plan and five OOXML destructive controls, renders every positive and negative deck, and performs a real PowerPoint save/reopen. A separate PowerPoint-authored fixture proves that three empty bullet paragraphs inherited from the master are removed while all three non-empty native paragraphs, the layout/master/theme, relationships, and preserve-only slide remain unchanged. Six source-template controls reject stale input, a wrong placeholder, blank-bullet reinsertion, non-empty paragraph deletion, same-slide drift, and master-bullet mutation. The current content-addressed scorecard is `3d4686a79e1ff261af4a11393e03010b5a2e61ed17ad9c907b0e037e4beae7fe`.

## Public reproducibility

Run `npm run evidence:ci` on a fresh host to execute the portable test, compiler, linter, and destructive-control layer and verify the committed content-addressed release scorecards. Public GitHub Actions runs the same command on Ubuntu and Windows and publishes the complete logs, fresh-host scorecard, replication report, and evidence verification as downloadable artifacts. See [public quality evidence](evidence/README.md) for exact capable-host regeneration commands and explicit scope limitations.

## Controlled export-fidelity benchmark

The competition benchmark renders six owned design specifications—invitation, brochure, and website, each in horizontal and vertical/mobile composition—through both a browser reference path and a native PowerPoint path:

```powershell
npm run fidelity
```

That single command preflights the required runtime, captures exact browser references, exports the PPTX, creates native PowerPoint groups, checks every named object's text, font, integer size, color, position, rotation, and insets, renders all slides, builds difference images, runs a real PowerPoint ungroup/regroup round trip when PowerPoint is installed, and verifies the final delivery package before reporting success.

This controlled path alone proves exporter conformance, not image understanding; the separate independent-ingestion proof follows below. The current controlled run passes all 129 object checks with zero raster fallbacks and no overflow. It achieves 0.97528 global, 0.91844 foreground, and 0.72427 background-normalized average similarity; the latter prevents a blank background-colored slide from passing. See the [benchmark protocol](docs/BENCHMARK.md), [limitations](docs/LIMITATIONS.md), and [hackathon plan](docs/HACKATHON_PLAN.md).

## Independent image ingestion

`npm run ingestion` proves a separate, anti-circular path: an isolated vision parser saw only a metadata-free, hash-named PNG created by a different agent. The deterministic renderer then consumed only the frozen observation JSON, exported 13 native text objects and 10 native shapes, removed grouping locks, rendered the PPTX, rejected raster fallback, and scored the result without parser geometry. The first scored run passed the precommitted pixel gates at 0.95102 global, 0.93510 foreground, and 0.89922 background-normalized similarity; its blank control failed. A subsequent adversarial audit showed those flat-color metrics alone could miss erased text, so the release gate now also requires edge F1 ≥0.70. The reconstruction scores 0.79492, while a generated all-text-erased control scores 0.54784 and is rejected. The full evidence bundle is generated under `outputs/ingestion/`.

## Repository map

```text
.agents/plugins/marketplace.json        Repo-local plugin marketplace
plugins/slidewright/                    Installable Codex plugin
  .codex-plugin/plugin.json             Plugin manifest
  skills/slidewright/                   Reusable presentation workflow
packages/cli/                           Project CLI entry point
examples/demo/                          Reproducible demo specification
tests/                                  Deterministic compiler/linter tests
docs/                                   Product, architecture, rubric, and delivery plan
GOAL_STATUS.md                          Binary release register and evidence log
```

## Core commands

```powershell
node packages/cli/src/cli.mjs compile examples/demo/deck-spec.json --out outputs/demo/plan.json
node packages/cli/src/cli.mjs lint outputs/demo/plan.json --out outputs/demo/lint-report.json
node packages/cli/src/cli.mjs fonts outputs/demo/plan.json --out outputs/demo/font-report.json
node packages/cli/src/cli.mjs render outputs/demo/plan.json --out outputs/demo/slidewright-demo.pptx --preview-dir outputs/demo/previews
node packages/cli/src/cli.mjs reconstruct fixtures/independent/observed-design.json --out outputs/ingestion/reconstruction.pptx --preview-dir outputs/ingestion/previews
node packages/cli/src/cli.mjs preflight --out outputs/preflight.json
node packages/cli/src/cli.mjs verify outputs/demo/slidewright-demo.pptx --out outputs/demo/delivery-manifest.json --preview-dir outputs/demo/previews
python plugins/slidewright/skills/slidewright/scripts/audit_pptx.py outputs/demo/slidewright-demo.pptx --json outputs/demo/ooxml-audit.json
npm run defects
npm run powerpoint:adapter
npm run iteration
npm run design-profile
```

## Product documents

- [Product brief](docs/PRODUCT.md)
- [Requirements](docs/REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Build Week requirements](docs/BUILD_WEEK.md)
- [Evaluation strategy](docs/EVALUATION.md)
- [Demo and submission package](submission/README.md)
- [Roadmap](docs/ROADMAP.md)
- [Risk register](docs/RISK_REGISTER.md)
- [Copy-ready submission text](submission/SUBMISSION_COPY.md)
- [Visual fidelity benchmark](docs/BENCHMARK.md)
- [Hackathon and GitHub-star plan](docs/HACKATHON_PLAN.md)
- [Current limitations](docs/LIMITATIONS.md)
- [Public Codex/PowerPoint complaint ledger](docs/COMPLAINT_LEDGER.md)
- [Direct user feedback ledger](docs/USER_FEEDBACK_LEDGER.md)
- [Platform and dependency contract](docs/PLATFORM_MATRIX.md)

## Why this can win

Most AI presentation tools optimize for a screenshot that looks acceptable once. Slidewright optimizes for the file people actually have to keep working in. The proof is not a marketing claim: each deck build emits a native `.pptx`, a layout plan, lint results, rendered previews, and an OOXML audit that judges can inspect.

## How Codex contributed

Codex was used to research the current Build Week rules, scaffold the plugin and skill, translate the formatting problem into a deterministic architecture, implement the compiler/linter/renderer/auditor, generate tests, execute the PowerPoint pipeline, and inspect the rendered result. The human-provided product thesis and quality bar were decisive: editable PowerPoint over slide images, symmetric spacing, conventional type sizes, automatic text fit, and Course Explorer-level evidence before completion. The final submission will identify the primary `/feedback` session and document any additional GPT-5.6 sessions used before the release freeze.

Key human decisions still required before submission are the final target-user evidence, the public/private repository choice, the release scope, and the final demo narrative.

## License

MIT. See [LICENSE](LICENSE).
