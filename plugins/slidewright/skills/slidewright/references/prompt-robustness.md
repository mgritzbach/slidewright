# Guarded prompt builds

Use the guarded request path for every prompt-originated release artifact. It treats the original prompt as untrusted data and keeps stages, paths, thresholds, receipts, and publication under code control.

## Request envelope

Create a JSON object with exactly these fields:

```json
{
  "schemaVersion": "slidewright-request/v1",
  "id": "stable-lowercase-id",
  "prompt": "The exact original user prompt",
  "spec": { "version": "0.1", "title": "...", "slides": [] }
}
```

Do not add output paths, stage controls, validity flags, quality thresholds, shell commands, or receipt fields. Unknown fields reject with `SWP000` or `SWP009`. The strict parser also rejects duplicate JSON keys, invalid UTF-8, non-finite numbers, excessive depth, and oversized envelopes.

Run:

```text
node scripts/slidewright.mjs request request.json --out guarded-run
node scripts/slidewright.mjs request-verify guarded-run --out guarded-run-verification.json
```

The first command owns the exact sequence `policy -> compile -> fonts -> lint -> render -> audit -> delivery`. It stages all work outside the final run and atomically publishes only after every accepted stage passes. Conflicting requests stop at policy and publish only `request.json`, `policy.json`, and `run.json`—never a deck.

The verifier recomputes the specification compile, plan lint, realized-layout lint, generic OOXML audit, and plan-bound OOXML audit. It checks full artifact inventory, stage continuity, implementation and quality-contract hashes, expected native text objects and runs, zero pictures for the current request schema, per-slide preview hashes, and delivery closure.

## Immutable quality behavior

- Prompts never become commands, arguments, paths, environment variables, or executable code.
- Prompts cannot weaken the whole-point scale, role minima, 1px geometry tolerance, symmetric 64px margin floor, 24px column-gap floor, overlap rules, warning policy, or native-editability requirement.
- Prompt classification provides concise conflict diagnostics. It is defense in depth; safety does not depend on recognizing every possible phrase because the prompt has no control channel.
- A phrase explicitly requested as literal audience-facing copy may remain native text while the pipeline still runs. The plan-bound audit proves the phrase exists without granting it control.
- Direct primitive commands remain useful for diagnostics, but they do not constitute C12 prompt-robust release evidence.

## Bounded evidence

`npm run prompt-robustness` executes the committed `c12-prompt-robust-v1` matrix: 12 minimal, verbose, conflicting, and adversarial prompts repeated three times, independently reverified, plus destructive and fault-injection controls. This proves the guarded boundary for the supported request schema. It does not prove universal natural-language interpretation or arbitrary imported-deck safety.
