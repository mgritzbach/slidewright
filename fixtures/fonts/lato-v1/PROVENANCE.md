# Slidewright font-integrity fixture

The four fixture fonts are name-only modifications of Lato files published in
the Google Fonts repository under the SIL Open Font License 1.1. They use the
family name `Slidewright Fixture Sans` so the benchmark cannot accidentally
pass against an unrelated workstation installation. The original and derived
SHA-256 values, source URLs, license hash, expected OpenType embedding flags,
and the exact modification are recorded in `fixture-manifest.json`.

The fixture is intentionally redistributable and installable. The benchmark
installs it only for the duration of an isolated PowerPoint session and removes
only files and registry values it created.
