# Public quality evidence

This directory contains curated, content-addressed release scorecards. Generated working artifacts remain under ignored `outputs/`; only the compact scorecards required to reproduce and audit public claims are committed here.

## Verify on any fresh host

```powershell
git clone https://github.com/mgritzbach/slidewright.git
Set-Location slidewright
git checkout <tested-commit>
npm ci
python -m pip install -r requirements-ci.txt
npm run evidence:ci
npm run evidence:verify
```

The command runs all portable unit and destructive-control tests, compiles and lints the demo, verifies every committed scorecard and exact source command, and writes a fresh-host scorecard plus logs under `outputs/public-evidence/<platform>/`.

GitHub Actions runs this command independently on Ubuntu and Windows and uploads each complete folder as a 30-day artifact. The workflow grants only read access to repository contents.

## Regenerate the capable-host scorecards

These exact commands require the bundled Codex presentation runtime; the design-profile and feedback suites also require Microsoft PowerPoint for their final round-trip proof:

```powershell
npm ci
python -m pip install -r requirements-ci.txt
npm run setup:runtime
npm run defects
npm run design-profile
npm run feedback-contract
npm run evidence:publish
npm run evidence:verify
```

Microsoft PowerPoint is required for the capable-host round-trip stages. The public GitHub runners intentionally do not claim those stages.

`evidence:publish` refuses invalid scorecards and machine-specific paths. `evidence:verify` checks the manifest and file hashes, suite-specific negative-control counts, declared commands, and—when the corresponding generated outputs are present—exact equality with the current release outputs.

## Scope

The committed evidence proves only the scopes and limitations stated inside each scorecard. Fresh public CI reproduces the portable compiler, linter, and destructive-control layer and validates the content-addressed capable-host evidence. It does not pretend that GitHub-hosted runners contain PowerPoint or Codex's private presentation runtime.

The immutable Linux/Windows scorecards, cross-platform aggregate, public artifact IDs and digests, and replication report from the first complete public run are committed under [`c22/v1`](c22/v1/). Their verifier is part of `npm test` and `npm run evidence:verify`.
