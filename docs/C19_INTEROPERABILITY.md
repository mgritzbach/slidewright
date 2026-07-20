# C19 cross-suite interoperability evidence contract

C19 is not credited by a screenshot, a successful file upload, application detection, or a user saying that a deck looked correct. Publication requires six application-generated evidence bundles for one exact source deck and one exact clean Slidewright commit:

1. PowerPoint on Windows through owned COM automation.
2. PowerPoint on macOS through AppleScript automation.
3. Google Slides through authenticated browser automation.
4. Keynote on macOS through AppleScript automation.
5. LibreOffice Impress through UNO automation.
6. Canva through authenticated browser automation.

`fixtures/interoperability/c19-v1/contract.json` freezes the suite identities, minimum fixture inventory, semantic checks, and render checks. `schemas/c19-interop-suite.schema.json` documents the evidence envelope. The JavaScript verifier is authoritative and fails closed.

## What a suite bundle must prove

Every suite artifact is named `slidewright-c19-<suite>-<40-character-commit>` and contains `suite-evidence.json` plus every file named by its receipts. The evidence binds:

- the repository, exact clean commit, source PPTX bytes, result PPTX bytes, and semantic inventories;
- the application name, non-unknown version, host, automation protocol, owned process or authenticated browser trace, application log, and runner implementation;
- open/import, save/export, reopen, and a native sentinel-text edit that survives reopening;
- all slides rendered at reviewable resolution with readable, unclipped, and non-blank checks;
- preserved core behavior and explicit `preserved`, `changed`, or `unsupported` results for mixed emphasis, tables, charts, groups, and connectors.

The matrix importer opens and hashes the files in every downloaded artifact. It independently executes eight destructive controls per suite and refuses a partial matrix, mixed deck hashes, dirty or mismatched commits, unknown tool versions, self-reports, missing traces, incomplete semantics, missing renders, or unauthenticated GitHub artifact metadata.

Advanced features are reported honestly. An `unsupported` chart or connector result may describe real import behavior, but core native text, slide count, reading order, the editable sentinel, and absence of a full-slide raster fallback must be preserved.

## Host workflow

The application-specific adapter creates the bundle. On that same exact clean checkout, validate it before upload:

```text
node scripts/run-c19-interoperability-benchmark.mjs --evidence <bundle>/suite-evidence.json --out <bundle>/suite-validation.json
```

The Windows adapter uses a newly owned hidden PowerPoint COM process, refuses a pre-existing PowerPoint session, creates a native mixed-emphasis cross-suite source from the semantic-surface fixture, performs a named native text edit, saves, reopens, inventories the result independently from OOXML, and renders every slide:

```text
node scripts/c19/run_powerpoint_windows_suite.mjs --source <semantic-surface.pptx> --out <artifact-root> --repository <owner/repo>
```

The LibreOffice adapter refuses every pre-existing LibreOffice process, launches an isolated headless profile and socket, performs the sentinel edit through the real UNO Java bridge, exports and reopens PPTX, exports a PDF through Impress, renders every PDF page, waits for natural application termination, and applies the same independent OOXML and destructive-control gates:

```text
node scripts/c19/run_libreoffice_suite.mjs --source <semantic-surface.pptx> --out <artifact-root> --repository <owner/repo>
```

The host must provide LibreOffice, Java/Javac, and `pdftoppm`. Override discovery only with explicit executable paths: `SLIDEWRIGHT_LIBREOFFICE`, `SLIDEWRIGHT_JAVA`, `SLIDEWRIGHT_JAVAC`, and `SLIDEWRIGHT_PDFTOPPM`. Installation or detection never counts as evidence; only a clean-commit bundle that independently validates does.

After all seven GitHub artifacts (six suite bundles and the matrix artifact) are downloaded, publish only through:

```text
node scripts/import-c19-evidence.mjs --input <download-root> --artifacts <github-artifacts.json> --run-id <id> --source-commit <sha> --repository <owner/repo>
node scripts/verify-c19-interop-evidence.mjs
```

Running the benchmark without `--evidence` prints capability and publication status. A detected application remains `evidence: false`; this prevents a local installation from being mistaken for a completed suite run.

## Current proof boundary

The contract, importer, verifier, destructive controls, PowerPoint Windows adapter, and LibreOffice UNO adapter exist. Until six real bundles are imported, `evidence/c19/v1/current.json` does not exist and the release verifier fails. That explicit pending state is intentional. Application detection is not credited, and the macOS and authenticated web suites require their respective hosts and sessions.
