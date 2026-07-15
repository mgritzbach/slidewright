# Slidewright engineering contract

## Product invariant

Never trade editability or formatting integrity for a prettier screenshot. All visible text must remain native text, mixed emphasis must remain run-level formatting, and generated layouts must pass the compiler, linter, export audit, and rendered-slide review.

## Required checks

Run these before claiming a change is complete:

1. `npm test`
2. `npm run demo:compile`
3. `npm run demo:lint`
4. For renderer or export changes: `npm run demo:render` and `npm run demo:audit`
5. Inspect every rendered slide at full size; a montage is only a deck-level overview.

Record evidence in `GOAL_STATUS.md`. Keep binary goals at `0` until the named proof exists.

## Implementation rules

- Keep the plugin self-contained under `plugins/slidewright/`.
- Put deterministic mechanics in scripts; keep the skill instructions concise.
- Prefer conventional integer point sizes from the token set over arbitrary or fractional values.
- Keep outer margins and component padding symmetric unless the input specification explicitly overrides them.
- Shorten or relayout content before allowing font sizes below the configured minimum.
- Treat warnings as build failures in the demo and release pipeline.
- Use native editable shapes, text, charts, and tables. Rasterize only true visual assets.
- Preserve user-provided templates and existing decks; never silently restyle them.

## Repository hygiene

- Generated artifacts belong under `outputs/` and are not committed unless needed as a curated fixture.
- Do not add secrets, personal data, or proprietary templates.
- Keep source files UTF-8 and commands cross-platform where practical.
