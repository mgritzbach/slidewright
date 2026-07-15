# Contributing to Slidewright

Start with an issue that states the formatting invariant or user failure being addressed. Keep deterministic mechanics in scripts, keep the skill concise, and do not replace editable content with screenshots.

Before opening a pull request, run:

```powershell
npm test
npm run demo:compile
npm run demo:lint
npm run demo:render
npm run demo:audit
```

Renderer, grouping, export, and fidelity changes must also run `npm run fidelity`, include the generated JSON evidence, and document full-size review of every affected slide. Warnings are failures.

New benchmark fixtures must be owned or licensed and include provenance. Use stable object names, approved integer font sizes, symmetric spacing unless intentionally overridden, and native editable objects.
