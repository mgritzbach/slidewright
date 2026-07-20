# C02 genuine Codex client evidence

C02 is an adoption gate, not an installation-only gate. A successful CLI install,
an app-server backend response, or an agent saying that Slidewright is available
does not prove that a real Codex client injected and used the installed skill.

Completion requires three distinct surfaces on one exact public release:

1. the existing clean-home CLI installation proof;
2. one newly loaded, primary Codex Desktop task;
3. one newly loaded, primary Codex VS Code extension task.

Desktop- or VS Code-spawned subagents do not count as primary client tasks. A task
whose skill registry was loaded before Slidewright was installed also does not
count, even if the installation is refreshed later.

## Primary-client prompt

Choose two new, distinct 16-64 character nonces, one per client surface, and
send the matching nonce as the first Slidewright request in each fresh primary
client task:

```text
$slidewright SLIDEWRIGHT_C02_NONCE=<nonce>
Read the installed Slidewright SKILL.md, report its installed path and version,
run the installed skill's preflight, and finish your response with exactly:
SLIDEWRIGHT_C02_NONCE=<nonce>
```

The nonce must come from the user message after the client has injected its skill
registry and before Slidewright is selected or its installed `SKILL.md` is read.
Do not reuse an earlier task's response as proof for a later installation.

## Capture and verification

After the task completes, capture the genuine client rollout against the exact
public source commit:

```text
node scripts/capture-c02-client-session-evidence.mjs \
  --rollout <client-rollout.jsonl> \
  --installed-skill <absolute-installed-SKILL.md> \
  --surface codex-desktop \
  --source-commit <40-character-public-commit> \
  --out outputs/c02/codex-desktop-proof.json
```

Use `--surface vscode-extension` for the VS Code task. That surface deliberately
remains fail-closed until a genuine VS Code rollout establishes its real client
originator contract; do not relabel a backend or caller-supplied identity to make
the capture pass. Preserve the genuine rollout when the command reports that the
originator contract is not yet known so the verifier can be extended from primary
evidence rather than a guess. Then verify each accepted proof:

```text
node scripts/verify-c02-client-session-evidence.mjs outputs/c02/codex-desktop-proof.json
node scripts/verify-c02-client-session-evidence.mjs outputs/c02/vscode-extension-proof.json
```

Creditable proof must report all of these as `true`:

- `discoveryValid`
- `installedReadValid`
- `clientInvocationValid`
- `nonceProofValid`
- `surfaceComplete`

The verifier rejects caller labels, backend identities, self-reports, stale task
registries, installations that happened after registry injection, missing installed
file reads, late nonces, and subagent sessions. Keep C02 at `0` until both genuine
primary-client surfaces and a freshly rerun CLI installation proof bind to the
same exact public commit. The Desktop and VS Code proofs must also use distinct
session ids and distinct nonces; replaying one task on two labels is invalid.
