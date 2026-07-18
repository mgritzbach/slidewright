# Slidewright

[![Core CI](https://github.com/mgritzbach/slidewright/actions/workflows/ci.yml/badge.svg)](https://github.com/mgritzbach/slidewright/actions/workflows/ci.yml)

**Editable decks, engineered rather than approximated.**

Slidewright is a Codex plugin and deterministic layout compiler that turns ideas and structured content into native, editable PowerPoint decks without the usual formatting damage. It treats slide generation like a build pipeline: compile constraints, render native objects, lint the result, inspect the exported OOXML, and retain evidence.

Prompt-originated release builds use a sealed request runner that treats the prompt as inert data and unconditionally executes compile, font audit, plan lint, native render, realized-layout lint, plan-bound OOXML audit, optional executive review, and delivery verification before atomic publication. Run `npm run prompt-robustness` for the bounded 36-run adversarial proof.

The Build Week entry targets **Work & Productivity**. The initial vertical slice proves the hardest, most reusable behaviors:

- equal outer margins and symmetric internal padding;
- automatic text fitting that selects conventional integer point sizes;
- native editable text and shapes;
- mixed bold and regular text runs;
- overflow, clipping, and formatting lint rules;
- machine-readable QA evidence for every build.

These are deck-wide contracts, not demo-specific styling. Schema `0.2` resolves a logical design master, page archetypes, typography roles, compact inset tokens, native paragraph spacing, repeated-component families, semantic icon bindings, headline budgets, and strict text/backing containment before any slide is exported. Built-in archetypes now include hero, section, comparison, continuation, native table, and semantic icon-list pages.

## Quick start

### Install in Codex

The simplest path is the standalone skill. Ask Codex:

> Install the Slidewright skill from https://github.com/mgritzbach/slidewright/tree/main/plugins/slidewright/skills/slidewright

Start a new task after installation so `$slidewright` is discovered. The public-main install has been validated, bootstrapped in a clean workspace, and invoked by a fresh Codex CLI client without relying on marketplace UI.

On newer Codex builds that expose plugin management, install the complete plugin from the public marketplace:

```powershell
codex plugin marketplace add mgritzbach/slidewright
codex plugin add slidewright@slidewright
codex plugin list
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

`npm run setup:runtime` discovers a supported local Codex presentation runtime rather than relying on a version-specific path or public download. Resolution is deterministic: an explicit local override, an already valid workspace package, then Codex's bundled dependency runtime. Explicit overrides fail closed when invalid instead of silently selecting something else. Every successful bootstrap smoke-imports `Presentation` and `PresentationFile` and reports the exact source, host profile, artifact-tool version, download state, and renderer-switch state.

To verify the universal design contract across unrelated slide types, real native tables, semantic icons, paragraph spacing, and screenshot-independent negative mutants, run:

```powershell
npm run universal-design
```

The command rebuilds seven slides across six archetypes, checks 21 isolated plan mutants (including table-cell overflow, contract mutation, custom-contract injection, and 6+6pt stacked spacing) and seven exported-OOXML mutants (including visible backing spill, repeated-component style, and headline-size drift), binds the native PPTX to 45 named objects, 35 native paragraphs, one native table, four semantic icons, zero pictures, and seven individually reviewed full-size visual baselines. A 45x single-card copy stress must split into continuation slides while every peer card keeps one common body style. Any rendered drift requires a new full-size review before the baseline can be updated.

Supported local overrides are `SLIDEWRIGHT_CODEX_RUNTIME_ROOT` and `SLIDEWRIGHT_ARTIFACT_TOOL_PATH`. They must point to existing local resources; Slidewright never interprets them as URLs or executes an external bootstrap helper. A clean host with no supported runtime exits once with `SW_RUNTIME_UNAVAILABLE` and one recovery instruction. Test the current native-host checkpoint with:

```powershell
npm run runtime:benchmark
```

The public CI matrix runs the same contract on native Windows, macOS, and Linux hosts, uploads semantically verified raw command receipts, and aggregates the three scorecards only when their implementation and contract hashes match. The credited C03 release additionally binds a genuine WSL2 profile with Microsoft kernel/filesystem evidence; a Linux runner with injected WSL variables is still rejected.

The installed skill has the same self-contained bootstrap as `node <slidewright-skill>/scripts/slidewright.mjs bootstrap`; it links the already bundled Codex runtime into the active workspace and does not download or silently switch renderers. Slidewright's clean-home installation benchmark verifies real CLI installation plus Desktop- and VS Code-identified **app-server backend discovery** without relying on marketplace UI clicks; it does not claim to launch either GUI client. The pinned harness is isolated under `tools/installation/` and runs with `npm ci --prefix tools/installation` followed by `node scripts/run-installation-benchmark.mjs`. If an older Codex build does not expose `codex plugin`, update Codex before installing Slidewright.

Outputs are written to `outputs/demo/` and include the editable PPTX, rendered previews, compiled layout plan, and QA reports.

### Optional E6 partner review

Set `"reviewMode": "executive-overlay"` in a guarded request to receive two decks: the clean verified `deck.pptx` and `deck.executive-review.pptx`, a separate editable copy with concise yellow partner-review boxes over claims, decisions, dense passages, or storyline transitions that need human judgment. Use `"reviewMode": "off"`—the default—to publish only the clean deck. Unsupported values fail before compilation.

```powershell
npm run executive-review
```

The toggle benchmark builds the same request both ways and requires the canonical PPTX to remain byte-identical, the off build to contain no review copy or hidden E6 objects, and every on-build note to be native editable text with a bound target, yellow fill, exact object name, and independent OOXML audit.

To prove that ordinary edits do not collapse the layout, run the whole-word copy mutation benchmark:

```powershell
npm run mutation
```

It rebuilds -25% and +25% copy variants, then lints, renders, audits, overflow-tests, bundles, and verifies both decks.

For translated or dense copy, use the structural adapter before compilation:

```powershell
node packages/cli/src/cli.mjs adapt input-spec.json --out adapted-spec.json --manifest adaptation.json
npm run copy-resilience
npm run copy-resilience:verify
```

The adapter keeps titles and visual hierarchy intact, moves overflow copy into native editable continuation slides, and preserves every normalized word token exactly once and in order with its bold, italic, color, bullet, and level state. It balances chunks across the minimum slide count and refuses output above the configured slide ceiling. Whitespace and source run boundaries may normalize at continuation breaks; visible text remains native and editable. Prompt-originated guarded builds run the same adapter automatically. The standalone verifier rehashes the implementation and every published artifact, then independently recomputes fixed and adapted plans, lint, and content conservation.

Missing-font and extreme-density negative controls are reproducible with:

```powershell
npm run repair
```

The command proves that missing fonts and content outside the bounded adaptive layouts or configured slide ceiling block export with actionable diagnostics; no silent fallback or tiny-text PPTX is emitted.

For the licensed embedded-font round-trip proof, run:

```powershell
npm run font-integrity
npm run font-integrity:verify
```

The C11 fixture uses an OFL-licensed four-style family, native mixed-emphasis text, an editable group, a native table, and a real master/layout. The gate requires all four embedded payloads and the exact visible style fingerprint to survive two Microsoft PowerPoint save/reopen cycles, while missing-family, removed-payload, truncated-payload, and visible-substitution controls must fail. This qualifies preservation of the licensed fixture; Slidewright does not silently embed or redistribute arbitrary user fonts.

For the release-level repair-free gate on Windows with Microsoft PowerPoint installed, run:

```powershell
npm run repair-free
npm run repair-free:verify
```

This deletes and regenerates the producer outputs for 26 byte-unique decks across standalone invite, brochure, website, copy-stress, native chart/table/diagram, template/edit, ingestion, prompt, and broad semantic families. Every snapshotted source and PowerPoint `SaveAs`/reopen output must independently pass ZIP CRC and OPC relationship/content-type closure, pinned `DocumentFormat.OpenXml` 2.20.0 schema validation, an isolated hidden PowerPoint process with alerts enabled, exact native text/run/paragraph/frame/shape/chart/table/group state, an exact-PID armed out-of-process visible-window/repair-signal watcher, global PowerPoint quiescence, and a content-loss-sensitive semantic inventory. The standalone verifier rehashes the complete evidence tree and implementation closure and reruns the package, SDK, and semantic audits. Thirteen destructive controls—including a real PowerPoint repair-dialog mutant, chart-label, hyperlink-target, and native-diagram content-loss mutants, plus a 13-case watcher/worker forgery matrix—must be rejected. Publication is content addressed and advances `current.json` only after final verification. The SDK package is downloaded only by this explicit command, pinned by both package and assembly SHA-256, disclosed in the scorecard, and never changes the renderer.

`npm run repair-free:reuse` is a development-only diagnostic. It publishes under `outputs/repair-free/development/`, forces `releaseEvidence: false`, and cannot replace the release pointer or qualify C04.

To run the two-phase geometric and readability defect matrix, including a real Microsoft PowerPoint text-bound check on Windows, run:

```powershell
npm run defects
```

The matrix covers canvas and parent clipping, text overflow, unintended overlap and occlusion, contrast, compiler-declared alignment, wrapping, crowding, and bounded chart-component readability. It repeats every isolated negative three times, rejects a false fit only visible after layout export, deletes an intentionally clipped PowerPoint after the real application rejects it, and writes a content-addressed scorecard under `outputs/defects/`. Chart checks derive label, mark, collision, bounds, contrast, and orientation results from rendered native-shape child geometry; they do not claim native PowerPoint chart export.

## Template-preserving edit benchmark

`npm run template` exercises the deliberately narrow existing-deck path on an MIT-licensed, PowerPoint-authored golden fixture. The editor changes only declared text nodes in two uniquely named native placeholders and refuses stale source hashes, unexpected source text, or ambiguous shapes. The audit proves that every other package part, relationship, master, layout, theme, and preserve-only slide is unchanged, then PowerPoint serializes a new file with `SaveAs`, opens it again, and rerenders the result. Five destructive controls prove that theme drift, control-slide drift, same-slide non-target drift, extra package parts, and stale edit contracts are rejected.

This is evidence for exact named-placeholder copy edits, not a claim of general PowerPoint import or arbitrary deck restructuring. The generated deviation log is written to `outputs/template/deviation-log.json`.

For the broader preservation matrix, run `npm run template:matrix`. Four licensed template families cover native charts with workbooks, native tables, image-heavy repeated layouts, and a multi-layout branded deck. The matrix verifies 39 slides through source, authorized edit, PowerPoint round trip, repeated PowerPoint round trip, and visible-negative states; audits source-object identity, masters, layouts, placeholders, themes, relationships, notes, hyperlinks, media, charts, workbooks, tables, spacing, and recurring chrome; and binds 195 individual full-size review decisions to exact render hashes. Use `npm run template:matrix:verify:published` to verify the compact committed C10 evidence without rerunning PowerPoint.

This qualifies preservation for the four licensed fixture families and their declared edit contracts. It still does not claim arbitrary structural import or unrestricted editing of every third-party deck; that remains the separate C17 scope.

## Lossless structural PPTX ingestion

When an existing native deck must enter the workflow without flattening its contents, run the structural importer and its release evidence gate:

```powershell
python plugins/slidewright/skills/slidewright/scripts/structural_ingestion/import_structural.py import source.pptx imported.pptx --manifest structural-manifest.json
npm run structural-ingestion
npm run structural-ingestion:verify
```

The C17 matrix uses four licensed decks and independently checks the complete OPC part inventory plus slide-to-layout-to-master-to-theme hierarchy, exact native text runs, tables, charts, diagrams, notes, and recursive semantic reading order. Eight destructive controls prove that loss in any named surface is rejected. The importer is a lossless preservation boundary: it does not claim unrestricted editing or semantic reconstruction of every imported Office object.

## Cross-suite interoperability status

Run `npm run interoperability:status` to see which of the six target application suites are callable and which have real evidence. The command deliberately exits nonzero until exact-deck, clean-commit, automation-trace, native-edit, re-export, semantic-inventory, and rendered-slide evidence has been imported for PowerPoint Windows, PowerPoint macOS, Google Slides, Keynote, LibreOffice, and Canva. Capability detection alone never counts. See [the C19 evidence contract](docs/C19_INTEROPERABILITY.md).

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

## Native semantic-surface benchmark

Run `npm run semantic-surface` to build and audit a controlled four-slide deck containing nested real PowerPoint groups, horizontal and vertical native Office charts, a native table, attached connectors, a declared raster visual asset with alt text, and meaningful speaker notes.

The suite freezes the exact object inventory, text-bearing shape hashes, recursive group paths, z-order, cached chart data and orientation, table-cell matrix, connector endpoints, media relationship/hash/alt text, reading order, and notes. Three exports must be byte-identical. Nine destructive controls must reject flattening, relationship drift, detached connectors, stripped notes, hierarchy drift, and undeclared objects. On Windows, newly owned, time-bounded Microsoft PowerPoint workers must SaveAs/reopen the deck with the same frozen semantic fields and exact source/round-trip slide renders. The current credited C08 release evidence is versioned and content-addressed; `npm run semantic-surface` regenerates it and the verifier refuses dirty, stale, incomplete, or process-unsafe runs.

This is the bounded C08 proof of complete semantic representation and preservation. It does not claim general third-party PPTX ingestion or arbitrary mutation/readability guarantees for every Office chart, table, or diagram; C17 remains separate, while C18 qualifies only the five declared mutation operations below.

For the bounded C18 mutation suite, first publish a fresh hardened C08 baseline, then run `npm run semantic-mutation`. Five isolated real-PowerPoint cases edit horizontal and vertical chart data, one table cell, one diagram node with its label, and one connector style. The runner requires exact before/mutated/reopened state, full collateral-package preservation outside operation-specific masks, exact connector sites, chart-label and table-fit readability, six four-slide render sets, and nine destructive controls. The credited release also binds 24/24 individual full-size review decisions through `npm run semantic-mutation:review -- --input <review-decisions.json>`; no broader native-object claim is implied.

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

The first independently aggregated replication is recorded in [the C22 fresh-machine report](evidence/c22/v1/FRESH_MACHINE_REPLICATION.md).

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
