# C19 macOS desktop runner runbook

Slidewright has two application-bound macOS adapters:

- `scripts/c19/run_powerpoint_macos_suite.mjs` drives Microsoft PowerPoint through AppleScript.
- `scripts/c19/run_keynote_macos_suite.mjs` imports and drives the deck through Keynote using AppleScript.

Their presence is not interoperability evidence. A qualifying bundle must be created on macOS from the exact clean commit and exact source PPTX used by all six C19 suites, then inspected and imported through the frozen matrix contract.

## Safety and prerequisites

1. Use a dedicated macOS test host with the repository at the exact matrix commit.
2. Fully close PowerPoint or Keynote before its run. Each worker refuses a pre-existing process, launches exactly one application process, binds its PID, and refuses to force-kill it.
3. Install Python 3 with Pillow and `pdftoppm` (Poppler), and ensure `osascript` is available.
4. Grant only the macOS Automation permission needed for `osascript` to control the target application. If macOS presents a permission dialog, stop for the host owner; do not bypass or script the privacy prompt.
5. Keep the checkout clean. Generated bundles should live under ignored `outputs/` or outside the repository.

PowerPoint:

```text
node scripts/c19/run_powerpoint_macos_suite.mjs \
  --source <canonical-source.pptx> \
  --out outputs/c19/powerpoint-macos-<commit>-suite \
  --repository <owner/repo>
```

Keynote:

```text
node scripts/c19/run_keynote_macos_suite.mjs \
  --source <canonical-source.pptx> \
  --out outputs/c19/keynote-macos-<commit>-suite \
  --repository <owner/repo>
```

## What each runner proves

The shared orchestrator prepares the same mixed-emphasis semantic-surface source and independently resolves one named native-text target from OOXML. It records both the PowerPoint object name and the exact source text because Keynote may rename imported objects.

The application worker then:

1. refuses an existing target-application process and launches one owned process;
2. imports/opens the prepared PPTX and changes the resolved native text object;
3. saves and reopens in the application's native workflow;
4. verifies the native edit after reopen;
5. exports a distinct PPTX, re-imports it, and verifies the native text again;
6. exports an application-produced PDF;
7. quits and waits for the owned process to exit naturally.

The Node orchestrator renders the application PDF with `pdftoppm`, inventories source/result PPTX packages independently, requires exactly one declared visible-text mutation in reading order, rejects full-slide rasterization, derives every advanced-feature outcome from OOXML counts, verifies every artifact receipt, and executes the shared destructive controls.

PowerPoint saves directly to an Open XML presentation before re-import. Keynote first saves a native `.key` working document, reopens it, exports to PowerPoint, and re-imports the exported PPTX before the PDF export. Apple documents that Keynote on Mac can open and edit PowerPoint files and export PowerPoint and PDF copies; Microsoft documents PDF and Open XML presentation formats in the PowerPoint `SaveAs` model.

## Required human review and publication

The first phase deliberately does not write `suite-evidence.json` and does not invoke the central validator. It writes `pending-suite-evidence.json`, a non-valid pending `suite-validation.json`, and `receipts/visual-review-template.json` with exact image hashes and `pending` decisions. Pixel checks prove only that the renders are nonblank and mechanically readable; they cannot qualify as human review. Before upload or matrix import:

1. inspect every `renders/slide-*.png` individually at full size;
2. reject overlap, clipping, blank/corrupt output, unreadable type, or application conversion warnings;
3. complete a copy of the template with `reviewMethod: full-size-human`, a post-run `reviewedAt`, a pseudonymous reviewer SHA-256, `pass` decisions, all three checks set to `true`, and notes for every slide;
4. finalize on the same clean commit:

   ```text
   node scripts/c19/run_powerpoint_macos_suite.mjs --out <artifact-root> --repository <owner/repo> --finalize-review <completed-review.json>
   node scripts/c19/run_keynote_macos_suite.mjs --out <artifact-root> --repository <owner/repo> --finalize-review <completed-review.json>
   ```

5. rerun `node scripts/run-c19-interoperability-benchmark.mjs --evidence <bundle>/suite-evidence.json --out <bundle>/suite-validation.json` on the same clean checkout;
6. record the external review in the release evidence/`GOAL_STATUS.md`, and publish only after all six application artifacts share one source deck SHA-256 and source commit.

Before finalization the runner sets `manualFullSizeReviewRequired: true`; after successful hash-bound finalization it records `manualFullSizeReviewRequired: false` and the pseudonymous review receipt. A `pass-precheck` decision is rejected. C19 remains `0` until the six-suite public matrix is imported and independently verified.
