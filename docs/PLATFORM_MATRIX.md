# Platform and dependency contract

Slidewright never silently installs a renderer or switches presentation engines. Each release build emits `preflight.json`, which records the detected Node, Python, artifact-tool package, runtime source and version, fonts, PowerPoint, and LibreOffice capabilities with explicit remediation.

| Capability | Windows | macOS | Linux | WSL |
| --- | --- | --- | --- | --- |
| Compile and lint | Supported; CI | Supported; CI | Supported; CI | Compatible target; genuine-host proof pending |
| Runtime discovery and bootstrap contract | Native-host matrix | Native-host matrix | Native-host matrix | Pending genuine WSL host |
| Native PPTX export via a present Codex runtime | Verified capable host | Requires a present supported runtime | Requires a present supported runtime | Requires a present supported runtime |
| Missing-runtime behavior | One local-only actionable failure | One local-only actionable failure | One local-only actionable failure | One local-only actionable failure |
| Real PowerPoint open/save and group round trip | Supported when desktop PowerPoint is installed | Planned | Not available | Not available |
| LibreOffice interoperability | Optional and never selected implicitly | Optional | Optional | Optional |

The native-host matrix proves both branches of the current checkpoint. A present supported local `@oai/artifact-tool` package at or above the minimum is linked and smoke-imported without a download. A host without that package exits once with `SW_RUNTIME_UNAVAILABLE`, leaves even a nonexistent target workspace untouched, and names the supported recovery. An invalid explicit override exits once with `SW_RUNTIME_OVERRIDE_INVALID` and cannot fall through to another renderer or an existing workspace package.

Unit tests cover WSL detection, but C03 remains `0` until the same benchmark executes in a genuine WSL process and records non-injected host/kernel evidence. Linux CI with synthetic WSL environment variables is deliberately rejected as insufficient.

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
- Arial and Georgia for the controlled benchmark. Missing required fonts block that benchmark instead of triggering substitution.
- `package-lock.json` for reproducible public npm dependency metadata.
- `evidence/runtime-bootstrap-contract.json` for the four profiles, destructive controls, implementation closure, and no-download policy.

C03 remains uncredited until the exact-implementation public native-host aggregate and genuine WSL evidence both exist and have been independently reproduced from their raw command receipts.
