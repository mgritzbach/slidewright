# Slidewright visual fidelity benchmark

## Prompt-robust workflow (C12)

`npm run prompt-robustness` runs the committed `c12-prompt-robust-v1` matrix through the sealed request boundary. The suite contains 12 exact prompts—two minimal, two verbose, four conflicting, and four adversarial—and repeats every case three times. Accepted cases execute policy, compile, font audit, plan lint, render, realized-layout lint, generic and plan-bound OOXML audits, and delivery verification. Rejected cases publish no plan or PPTX.

The scorecard requires byte-identical plans and normalized PPTX outputs for repeated and semantically paired cases, independently recomputed verification, zero-warning native text closure, 14 destructive receipt/artifact controls, eight stage fault injections, and absence of the command-injection sentinel. Three unique positive decks produce nine per-slide PNGs for individual original-resolution review. The machine scorecard and review record are content-addressed separately; a montage never qualifies as review evidence.

After recording one original-resolution decision for each of the nine PNGs, bind the review to the current machine scorecard with `npm run prompt-robustness:review -- --decisions outputs/prompt-robustness/review-decisions.json`.

This is a bounded prompt/build-boundary benchmark. It proves that the supported strict request schema cannot weaken or skip the pipeline; it does not claim universal prompt interpretation.

## Dense-copy and translation resilience (C15)

`npm run copy-resilience` runs five pinned cases: -25%, +25%, a human-authored expanded German translation, 2x flexible copy, and 4x flexible copy. The dense inputs must fail the fixed three-slide topology and then succeed through structural continuation slides; font shrinking alone cannot satisfy the gate. Every flexible field is source-hashed, and every normalized word token must appear exactly once and in order with its bold, italic, color, bullet, and level state retained. Whitespace and source run boundaries may normalize at continuation breaks.

Each positive deck passes deterministic adaptation, installed-font audit, zero-warning plan and realized-layout lint, native rendering, generic and plan-bound OOXML audits, `slides_test.py`, and verified bundle delivery. Ten diagnostic-bound destructive controls reject dropped, duplicated, reordered, or misowned chunks; source-hash tampering; forged fit; sub-minimum or fractional type; text overlap; and an actual exported all-raster PPTX. A production guarded request must exceed the 200-slide ceiling at compile and publish no plan, deck, previews, audit, or delivery. Every case publishes its source and adapted specifications, fixed and adapted plans, lint/audit reports, PPTX, and stable delivery evidence. Run `npm run copy-resilience:verify` to rehash the implementation and all artifacts and independently recompute the planning/content gates. The machine scorecard publishes every slide PNG for individual original-resolution review; a montage is not evidence. Finalize the review with `npm run copy-resilience:review -- --decisions outputs/copy-resilience/review-decisions.json`.

The suite proves the committed hero and two-column strategy with Arial and the pinned German fixture through 4x flexible copy. It does not translate languages, claim arbitrary scripts/layouts, or promise unlimited slide growth.

Slidewright's controlled exporter-conformance benchmark uses owned, deterministic browser ground truth rather than subjective screenshots. Six references cover an invitation, an information brochure, and a website in horizontal and vertical/mobile compositions. The browser and PowerPoint paths share a machine-readable design manifest; this isolates export fidelity but does not prove independent image understanding or ingestion.

## Feedback-contract benchmark

Run `npm run feedback-contract` for the `locate-event-feedback-v1` suite. It freezes the exact 17-topic outline recovered from direct user feedback and requires 34 native-editable slides: one unique divider and one unique substantive slide per topic, in manifest order.

The plan and realized-layout gates enforce `SW018` absolute text/reserved-region separation, `SW019` exact headline safe intervals, `SW020` exact text-backing growth, `SW021` topic ownership and sequence, and `SW022` empty-paragraph hygiene. Three deterministic compilations must match. Nine plan mutations and five exported-OOXML mutations must be rejected; the overlap, one-third-width headline, and half-height title-backing controls are also visibly wrong in their rendered target slides.

G28 adds a separate source-bound fixture whose body placeholder receives bullet formatting from the PowerPoint master body style. The sanitizer pins the source SHA-256, removes exactly three empty inherited bullet paragraphs, preserves canonical hashes for three non-empty paragraphs, changes only `ppt/slides/slide1.xml`, and leaves every relationship, master, layout, theme, and preserve-only slide byte-identical. Six destructive controls must fail. Microsoft PowerPoint then saves and reopens the sanitized deck with all three native inherited bullets visible, zero empty paragraphs, exact semantic state, and exact rerendered pixels.

The current scorecard hash is `3d4686a79e1ff261af4a11393e03010b5a2e61ed17ad9c907b0e037e4beae7fe`. This bounded suite proves the named contracts, not universal layout quality or arbitrary third-party template ingestion.

## Existing-deck design-profile benchmark

Run `npm run design-profile` to exercise the source-bound `g22-v1` path on the synthetic, PowerPoint-authored fixture under `fixtures/design-profile/mit-v1/`. The benchmark extracts the source twice and requires byte-identical profiles, adapts the raw OOXML inventory into a clone-only reuse contract, derives a stale-safe named-placeholder edit plan, edits a source copy, and audits the result.

The structural gate covers slide dimensions, theme and visible fonts, integer type sizes, palette, presentation guides, masters, layouts, placeholders, editable logo groups, recurring chrome, and rim/limiter geometry. Four rim/limiter pairs must be exactly symmetric in EMUs; one deliberately unequal 3pt/5pt divider pair is accepted only through its source-SHA and object-hash-bound asymmetry manifest. Pair equality is evaluated in exact EMUs. Eight destructive controls cover guide deletion, a one-EMU side-rail drift, limiter-color drift, logo rename, theme-font drift, undeclared same-slide drift, profile-integrity tampering, and a visibly widened rim whose rendered pixels must fail an exact comparator; every control must be rejected. Microsoft PowerPoint then saves and reopens the derived deck, after which structural state and both slide renders must match exactly. Source-to-derived comparison masks only the declared replacement text.

This benchmark proves bounded reuse inside a clone of the source deck. It does not prove arbitrary structural import, chart/table/diagram reconstruction, or synthesis of unrelated layouts.

### Source-native composition benchmark

Run `npm run setup:runtime` and then `node scripts/run-profile-composition-benchmark.mjs` for the rights-aware `g22-v2` path. It uses the committed MIT fixture to build a four-slide editable deck from a two-slide source by selecting source archetypes, cloning their native OOXML and inheritance, replacing only named native placeholder text, deterministically rebasing duplicated identities, and garbage-collecting every unreachable slide/media part.

The automated gate requires byte-identical repeat composition and provenance, an independent relationship-closure and source-object audit, eight forged negative controls, exact pixels outside declared text and dynamic slide-number masks, zero-overflow checks, a process-owned PowerPoint save/reopen, native semantic preservation, and at least 0.999 post-PowerPoint render similarity. Its scorecard remains `goalComplete: false` until a named human or primary agent inspects all four composed and all four roundtrip PNGs individually at full size. Complete the generated review template and run `node scripts/finalize-profile-composition-review.mjs --input <completed-review.json>`; the finalizer verifies the reviewer kind, pre-review scorecard hash, all eight image hashes, reviewer digest, timestamp, and eight explicit pass decisions before setting `goalComplete: true`.

This proves only licensed or explicitly authorized source-native archetype composition. It does not authorize redistribution, infer template rights, or claim arbitrary object import.

## Native semantic-surface benchmark

Run `npm run semantic-surface` for the controlled `slidewright-semantic-surface-scorecard/v2` suite. It creates three byte-identical exports of a four-slide native-object deck and freezes a recursive contract for 40 objects: 32 shapes, two nested groups, two native Office chart parts, one native table, two attached connectors, and one declared image. The contract also binds top-level order, six nested objects, exact cached chart direction/categories/series data, the 20-cell table matrix, connector endpoints, image relationship/media hash/alt text, and meaningful notes on all four slides. Version 2 additionally refuses a dirty checkout, binds the exact Git commit and implementation/runtime closure, hashes the complete raw receipt tree, and proves both normal watchdog completion and forced-parent recovery before publication.

Nine isolated controls must reject a broken chart relationship, chart flattening, table flattening, connector detachment, notes removal, nested-group flattening, hierarchy drift, image-relationship drift, and one undeclared object. Newly owned, time-bounded Microsoft PowerPoint workers must SaveAs and reopen the positive deck and render each slide without attaching to an existing user process. A separate timeout control deliberately hangs an owned PowerPoint worker, requires exact PID/name/start-time cleanup of the non-child COM process, and verifies that no owned process remains. A narrowly bounded relationship-rebase mode permits PowerPoint to move chart or media package part paths only when all frozen semantic fields, cached chart content, and relationships remain valid. Lossless PNG and review-JPEG renders must match exactly before and after the round trip, and two persisted `slides_test.py` reports must show no overflow.

The historical scorecard hash `c37f1786955eb2454bd430df72563c042f559a417f6897b2a2987db8637081ac` is retired. C08 is credited only through the current hardened, process-safe, content-addressed run and its independently verified receipt tree recorded in `GOAL_STATUS.md`. The bounded suite does not prove arbitrary existing-deck ingestion or general mutation/readability support for every native chart, table, and diagram.

## Native semantic-mutation benchmark

After `npm run semantic-surface` publishes a current hash-authenticated baseline, run `npm run semantic-mutation`. The runner refuses stale or missing C08 evidence and executes five isolated native PowerPoint mutations: horizontal-chart data, vertical-chart data, one table cell, one diagram node and companion label, and one connector style. Every case must survive SaveAs/reopen with its exact contracted state while canonical raw-object signatures and protected package parts remain unchanged outside operation-specific OOXML masks. Chart labels use PowerPoint-reported text and bounds; render analysis corroborates mark visibility. Table text must pass both static OOXML fit and PowerPoint bound measurements.

Nine controls separately attack collateral chart style, package data, connector attachment/site geometry, table fit, diagram-label placement, and render evidence. The machine scorecard requires six complete four-slide render sets but calls them review-ready, not reviewed. Inspect all 24 review images individually at full size, author exactly one pass/fail decision per deck and slide against the scorecard hash, then run `npm run semantic-mutation:review -- --input <review-decisions.json>`. The finalizer re-hashes every PNG and review image and publishes a separate content-addressed review record; a montage never satisfies this gate.

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

## Font-integrity benchmark

`npm run font-integrity` builds a two-slide native fixture from a pinned OFL-licensed four-style family, embeds four distinct payloads, and exercises regular, bold, italic, and bold-italic runs inside ordinary text, a real group, a native table, and a master/layout. Microsoft PowerPoint must save, reopen, save, and reopen the deck while retaining the exact style fingerprint, embedded relationships and payloads, native structure, and pixel-identical 1600x900 renders. Missing-family, removed-payload, truncated-payload, and visible-substitution controls must fail. `npm run font-integrity:verify` rehashes all 35 artifacts and the implementation closure independently.

## Structural-ingestion benchmark

`npm run structural-ingestion` imports four licensed PPTX fixtures into fresh deterministic containers and emits semantic manifests. An independent auditor requires exact part bytes and separately hashes slide/layout/master/theme hierarchy, run-level text, native tables, chart formulas and caches, diagrams, notes, and recursive reading order. Eight destructive controls each remove or alter one named surface and must be rejected. `npm run structural-ingestion:verify` accepts only content-addressed evidence from a clean exact commit in release mode. The proof covers lossless preservation, not arbitrary editing or semantic reconstruction of imported objects.
## Fine-grained named-iteration benchmark

Run `npm run iteration` to exercise six independent `c16-v1` edits: single-run text, run-level bold, color, position, a semantic horizontal native-shape chart value, and a named two-column gap. Each manifest pins the full baseline-plan content hash; the editor derives the exact changed-object closure and rejects stale hashes, missing targets, invalid values, no-ops, caller allowlist expansion, inventory changes, and collateral drift.

Every generated PPTX is normalized deterministically: relationship IDs and their owner references are sorted, core timestamps and creation IDs are fixed from stable inputs, and ZIP order and metadata are fixed. The repeat baseline must therefore be byte-identical. Whole-package comparison requires the same part inventory and semantic relationship tuples, rejects dangling references, hashes every named top-level object, and permits changes only inside editor-derived named-object subtrees. Native-shape charts store hash-checked canonical data in PowerPoint alternative text with `officeChart:false`; the chart edit must change both the root payload and the corresponding mark.

The render gate derives masks from exported OOXML geometry and requires exactly zero changed pixels outside those masks. Eight destructive controls cover unauthorized objects, relationship targets, dangling references, masters, extra parts, chart metadata, creation IDs, and off-mask pixels. On Windows, PowerPoint opens, saves, reopens, and preserves all named-shape properties?including semantic descriptions?for the baseline and all six variants; every post-PowerPoint render must be an exact pixel match.
