# Judge testing instructions

## Five-minute quick path

Requirements: Node.js 20+, Python 3.11+, and Codex Desktop with the bundled presentation runtime. Microsoft PowerPoint is optional for generation and required only for the two Windows round-trip proofs.

```powershell
npm ci
npm run setup:runtime
npm run preflight
npm run demo
npm run ingestion
```

Expected results:

- `outputs/demo/slidewright-demo.pptx` opens as a three-slide native editable deck;
- compile, font, and lint reports contain zero failures or warnings;
- the OOXML audit reports 18 native text nodes, zero pictures, approved whole-point sizes, and mixed bold/regular runs;
- rendered previews appear under `outputs/demo/previews/`.
- `outputs/ingestion/reconstruction.pptx` contains 13 native text objects and 10 native shapes with zero pictures, and its pixel plus edge gates pass.

Open the ingestion PPTX, edit the event title, move one shape, and toggle emphasis in a mixed-format text object. The content remains native and independently editable.

The exact clone → `npm ci` → runtime setup → preflight → demo → ingestion sequence completed from a clean temporary checkout in 73.2 seconds on the verified Windows host.

## Complete evidence path

```powershell
npm run release:check
```

This runs preflight, the current 253-test unit/destructive-control suite, the demo, universal design contracts, controlled fidelity, PowerPoint group round trip, copy mutation and continuation resilience, repair-free package validation, independent opaque-image ingestion, four-family template preservation, geometric/readability defects, fine-grained iteration, design-profile reuse, feedback contracts, prompt robustness, semantic-surface preservation, native-object mutation, and public-evidence verification.

On the verified Windows host, the complete release path takes roughly one hour because it performs repeated real-PowerPoint save/reopen sessions and regenerates all evidence producers. The five-minute quick path above is the intended judge smoke test. Platform-specific capabilities and exact dependencies are documented in `docs/PLATFORM_MATRIX.md`.

## Install as a Codex skill or plugin

After the GitHub release is published, use the marketplace commands in the root README on Codex builds that expose `codex plugin`. On older builds, copy `plugins/slidewright/skills/slidewright/` into the Codex skills directory, restart Codex, and begin a new task. The skill’s `bootstrap` command links the already bundled presentation runtime into the active workspace and does not download or silently switch renderers.
