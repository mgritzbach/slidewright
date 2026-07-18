# Platform and dependency contract

Slidewright never silently installs a renderer or switches presentation engines. Each release build emits `preflight.json`, which records the detected Node, Python, artifact-tool package, runtime source and version, fonts, PowerPoint, and LibreOffice capabilities with explicit remediation.

| Capability | Windows | macOS | Linux | WSL |
| --- | --- | --- | --- | --- |
| Compile and lint | Supported; CI | Supported; CI | Supported; CI | Verified genuine WSL2 profile |
| Runtime discovery and bootstrap contract | Native-host matrix | Native-host matrix | Native-host matrix | Verified genuine WSL2 profile |
| Native PPTX export via a present Codex runtime | Verified capable host | Requires a present supported runtime | Requires a present supported runtime | Requires a present supported runtime |
| Missing-runtime behavior | One local-only actionable failure | One local-only actionable failure | One local-only actionable failure | One local-only actionable failure |
| Real PowerPoint open/save and group round trip | Supported when desktop PowerPoint is installed | Planned | Not available | Not available |
| LibreOffice interoperability | Optional and never selected implicitly | Optional | Optional | Optional |

The separate C19 matrix is fail-closed across PowerPoint Windows, PowerPoint macOS, Google Slides, Keynote, LibreOffice, and Canva. It requires automation-bound native edits, re-exported PPTX packages, semantic inventories, and full-slide renders for the same source deck. None of those suites is credited merely because an application is installed or a file opens; run `npm run interoperability:status` for the current evidence state.

The native-host matrix proves both branches of the current checkpoint. A present supported local `@oai/artifact-tool` package at or above the minimum is linked and smoke-imported without a download. A host without that package exits once with `SW_RUNTIME_UNAVAILABLE`, leaves even a nonexistent target workspace untouched, and names the supported recovery. An invalid explicit override exits once with `SW_RUNTIME_OVERRIDE_INVALID` and cannot fall through to another renderer or an existing workspace package.

The credited C03 evidence combines the exact-commit Windows, macOS, and Linux native-host aggregate with a separately published genuine WSL2 run. The WSL profile records Microsoft kernel and filesystem evidence without an override; Linux CI with synthetic WSL environment variables remains deliberately insufficient.

## Resolution order

1. `SLIDEWRIGHT_ARTIFACT_TOOL_PATH` when explicitly set.
2. `SLIDEWRIGHT_CODEX_RUNTIME_ROOT` when explicitly set.
3. A valid workspace `@oai/artifact-tool` package.
4. Codex's local bundled dependency runtime under the user's runtime cache.

Explicit configuration is authoritative: an invalid explicit path fails closed. The resolver contains no URL, fetch, downloader, or package-install path, and the CI source audit enforces this local-only policy.

## Pinned inputs

- Node.js 20 or newer.
- Python 3.11 or newer.
- `@oai/artifact-tool` 2.7.3 or newer from a present local Codex runtime.
- Arial and Georgia for the controlled compiler benchmark. Missing required fonts block that benchmark instead of triggering substitution. The separate C11 fixture uses an OFL-licensed, collision-resistant four-style family and verifies its embedded payloads through two PowerPoint cycles.
- `package-lock.json` for reproducible public npm dependency metadata.
- `evidence/runtime-bootstrap-contract.json` for the four profiles, destructive controls, implementation closure, and no-download policy.

C03 is credited only for the versioned public evidence recorded in `GOAL_STATUS.md`. Future implementation changes must regenerate the exact-commit native aggregate and the genuine WSL evidence before replacing that proof.
