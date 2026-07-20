# C19 cross-suite interoperability evidence contract

C19 is not credited by a screenshot, a successful file upload, application detection, an API response in isolation, or a user saying that a deck looked correct. Publication requires six application-generated evidence bundles for one exact source deck and one exact clean Slidewright commit:

1. PowerPoint on Windows through owned COM automation.
2. PowerPoint on macOS through AppleScript automation.
3. Google Slides through authenticated browser automation or authenticated Slides API v1 plus Drive API v3 service automation.
4. Keynote on macOS through AppleScript automation.
5. LibreOffice Impress through UNO automation.
6. Canva through authenticated browser automation.

`fixtures/interoperability/c19-v2/contract.json` freezes the suite identities, mode-specific proof requirements, minimum fixture inventory, semantic checks, and render checks. `schemas/c19-interop-suite-v2.schema.json` documents the evidence envelope. The JavaScript verifier is authoritative and fails closed.

## What a suite bundle must prove

Every suite artifact is named `slidewright-c19-<suite>-<40-character-commit>` and contains `suite-evidence.json` plus every file named by its receipts. The evidence binds:

- the repository, exact clean commit, source PPTX bytes, result PPTX bytes, and semantic inventories;
- the application name, non-unknown version attribution, host, automation protocol, owned process or authenticated-service trace, application log, and runner implementation;
- open/import, save/export, reopen, and a native sentinel-text edit that survives reopening;
- all slides rendered at reviewable resolution with a review decision bound to each exact image hash;
- preserved core behavior and explicit `preserved`, `changed`, or `unsupported` results for mixed emphasis, tables, charts, groups, and attached connectors.

The matrix importer opens and hashes the files in every downloaded artifact. It independently executes destructive controls per suite and refuses a partial matrix, mixed deck hashes, dirty or mismatched commits, unknown tool versions, self-reports, missing traces, incomplete semantics, missing renders, false advanced outcomes, or unauthenticated GitHub artifact metadata.

Advanced features are reported honestly and are cross-checked against independent OOXML inventories. For example, if Google Slides converts the two Office charts into ordinary images, `native-chart` must be `unsupported`, the result inventory must contain zero native chart parts, and the bundle must still prove that the deck was not flattened into full-slide pictures. Core native text, slide count, ordered visible text, the editable sentinel, and absence of a full-slide raster fallback must remain preserved.

## Authenticated Google service automation

The v2 contract does not mislabel an API run as browser automation. `authenticated-service-automation` is a distinct proof mode with these requirements:

- OAuth-authenticated private-file operations and a SHA-256 pseudonym for the principal; access tokens, refresh tokens, client secrets, and private keys are prohibited from the bundle;
- captured discovery documents for `slides:v1` and `drive:v3`, including the exact discovery revisions used for version attribution;
- exact service origins `https://slides.googleapis.com` and `https://www.googleapis.com`;
- one resource-bound sequence: Drive import, Slides read, revision-controlled `batchUpdate`, Slides readback, Drive PPTX export, Drive PDF export, and Drive cleanup;
- distinct before/after revision hashes, request/response hashes, successful status codes, and timestamps for every operation;
- source and exported PPTX artifacts, the service-produced PDF, per-slide renders, API snapshots, and a hash-bound full-size visual review.

Google does not expose a user-facing Slides deployment build through these APIs. Slidewright therefore records `application.versionKind: api-discovery-revision`, derives the version string from the captured Slides v1 and Drive v3 discovery revisions, and records `serviceBuildExposed: false`. It never invents a Google Slides UI build number. The official API defines [`presentations.get`](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/get) and revision-controlled [`presentations.batchUpdate`](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate) at `slides.googleapis.com/v1`; Drive API v3 performs the import and [`files.export`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export) returns the Google presentation as PPTX and PDF bytes.

The repository runner is deliberately credential-free. An authenticated client creates a redacted capture matching `schemas/c19-google-slides-capture.schema.json`; the local importer receives no credentials:

```text
node scripts/c19/run_google_slides_suite.mjs \
  --capture <redacted-capture-root> \
  --out <artifact-root> \
  --repository <owner/repo>
```

The capture root must contain `capture-manifest.json` and hash receipts for the source/result PPTX, result PDF, application log, service trace, both discovery documents, before/update/after snapshots, review decisions, and every slide render. The importer rejects credential-like material, missing or altered files, a second undeclared text edit, a reading-order change, a visual-review hash mismatch, or a claimed advanced outcome that contradicts the independent inventories.

A visual defect cannot be normalized away only in the Google copy. If the exact shared fixture clips in Google Slides, that suite fails. Fix the canonical source fixture, commit it, and rerun every suite against the new exact bytes. This preserves the one-deck/same-commit requirement.

## Authenticated Canva browser automation

Canva evidence is imported from a real authenticated browser session, but the repository runner never receives a cookie, password, OAuth token, email address, local-storage dump, or raw resource URL. The browser session writes a redacted manifest, trace, and operation receipts matching `schemas/c19-canva-browser-capture.schema.json`, `schemas/c19-browser-trace.schema.json`, and `schemas/c19-browser-operation-evidence.schema.json`; identity and the created design are represented only by SHA-256 pseudonyms.

The capture binds one Canva origin and one created-resource lifecycle in this exact order: PPTX import, pre-edit open, native sentinel edit, save, reopen, PPTX export, PDF export, and resource deletion. Every operation has its own receipt, origin, resource digest, non-overlapping timestamps, action/observation hashes, and an operation-specific success observation. The native edit binds distinct before/after state hashes; reopen must bind the after state; export operations must bind the downloaded PPTX and PDF bytes; cleanup must explicitly record `resourceDeleted: true`.

Canva does not expose a stable public deployment version in the editor UI. The capture therefore records a SHA-256 fingerprint of the same-origin web-client scripts observed by the browser. Evidence reports this honestly as `versionKind: web-client-fingerprint`, `serviceBuildExposed: false`, and `web-client@<first-16-digest-characters>` rather than inventing a Canva release number.

The local capture importer is credential-free and runs only from an exact clean checkout:

```text
node scripts/c19/run_canva_suite.mjs \
  --capture <redacted-capture-root> \
  --out <artifact-root> \
  --repository <owner/repo>
```

The capture root contains `capture-manifest.json`, the exact shared source PPTX, Canva-exported PPTX and PDF, a redacted application log and browser trace, eight redacted JSON operation receipts, per-slide renders derived from the Canva PDF, and a hash-bound full-size visual review. The importer rejects secret- or identity-bearing text, wrong origins, missing authentication, reordered or overlapping operations, unbound state changes or downloads, an undeleted design, collateral text edits, false advanced-feature outcomes, a visual-review mismatch, and any altered artifact body. Browser capability detection or a successful upload alone never qualifies.

## Host workflow

The application-specific adapter creates the bundle. On that same exact clean checkout, validate it before upload:

```text
node scripts/run-c19-interoperability-benchmark.mjs --evidence <bundle>/suite-evidence.json --out <bundle>/suite-validation.json
```

The Windows adapter uses a newly owned hidden PowerPoint COM process, refuses a pre-existing PowerPoint session, creates a native mixed-emphasis cross-suite source from the semantic-surface fixture, performs a named native text edit, saves, reopens, inventories the result independently from OOXML, and renders every slide:

```text
node scripts/c19/run_powerpoint_windows_suite.mjs --source <semantic-surface.pptx> --out <artifact-root> --repository <owner/repo>
```

The two macOS adapters follow the same fail-closed contract through AppleScript. They refuse a pre-existing user session, own one application PID, bind the edit to the prepared OOXML target and exact source text, save/reopen, re-import the exported PPTX, export an application PDF, wait for natural process exit, and require independent OOXML, render, receipt, and destructive-control validation:

```text
node scripts/c19/run_powerpoint_macos_suite.mjs --source <semantic-surface.pptx> --out <artifact-root> --repository <owner/repo>
node scripts/c19/run_keynote_macos_suite.mjs --source <semantic-surface.pptx> --out <artifact-root> --repository <owner/repo>
```

See `docs/C19_MACOS_RUNNERS.md` for prerequisites, the Keynote object-name fallback, privacy-permission handling, and the mandatory full-size human-review boundary.
Mac runners stop with pending evidence after rendering. They write qualifying `suite-evidence.json` only in a second `--finalize-review` invocation whose external human review is bound to every exact slide-image hash; automated `pass-precheck` decisions are rejected.

The LibreOffice adapter refuses every pre-existing LibreOffice process, launches an isolated headless profile and socket, performs the sentinel edit through the real UNO Java bridge, exports and reopens PPTX, exports a PDF through Impress, renders every PDF page, waits for natural application termination, and applies the same independent OOXML and destructive-control gates:

```text
node scripts/c19/run_libreoffice_suite.mjs --source <semantic-surface.pptx> --out <artifact-root> --repository <owner/repo>
```

After all seven GitHub artifacts (six suite bundles and the matrix artifact) are downloaded, publish only through:

```text
node scripts/import-c19-evidence.mjs --input <download-root> --artifacts <github-artifacts.json> --run-id <id> --source-commit <sha> --repository <owner/repo>
node scripts/verify-c19-interop-evidence.mjs
```

Running the benchmark without `--evidence` prints capability and publication status. A detected application or available capture importer remains `evidence: false`; this prevents an installation or adapter from being mistaken for a completed suite run.

## Current proof boundary

The v2 contract, importer, verifier, destructive controls, PowerPoint Windows/macOS adapters, Keynote macOS adapter, LibreOffice UNO adapter, credential-free authenticated Google service capture importer, and credential-free authenticated Canva browser capture importer exist. A macOS runner source file or capability check is not runtime evidence. Exploratory runs made before the v2 contract and committed runners are not C19 evidence. Until six fresh real bundles from one later clean commit are imported, `evidence/c19/v2/current.json` does not exist, C19 remains `0`, and the release verifier fails intentionally.
