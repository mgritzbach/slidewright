# Platform and dependency contract

Slidewright never silently installs a renderer or switches presentation engines. Each release build emits `preflight.json`, which records the detected Node, Python, artifact-tool, presentation renderer, fonts, PowerPoint, and LibreOffice capabilities with explicit remediation.

| Capability | Windows | macOS | Linux | WSL |
| --- | --- | --- | --- | --- |
| Compile and lint | Supported; CI | Supported target; CI pending | Supported; CI | Supported target; CI pending |
| Native PPTX export via Codex presentation runtime | Supported on verified Codex hosts | Target; clean-host proof pending | Target; clean-host proof pending | Target; clean-host proof pending |
| OOXML audit and image render | Supported on verified Codex hosts | Target; proof pending | Target; proof pending | Target; proof pending |
| Real PowerPoint open/save and group round trip | Supported when desktop PowerPoint is installed | Planned | Not available | Not available |
| LibreOffice interoperability | Optional and never selected implicitly | Optional | Optional | Optional |

## Pinned inputs

- Node.js 20 or newer.
- Python 3.11 or newer.
- `@oai/artifact-tool` is resolved from the installed Codex presentation runtime by `npm run setup:runtime`; the exact runtime path and version are emitted by preflight.
- Arial and Georgia are the required benchmark fonts. Missing required fonts block the benchmark instead of triggering silent substitution.
- `package-lock.json` pins npm dependency metadata for reproducible installs.

“Target” is not a support claim. C03 remains blocked until clean-host fixtures prove Windows, macOS, Linux, and WSL behavior.
