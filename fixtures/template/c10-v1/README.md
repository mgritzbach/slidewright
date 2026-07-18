# C10 licensed template fixture matrix

This bundle provides four legally distributable, structurally different PPTX
fixtures for Slidewright's existing-template preservation benchmark.

| Fixture | License | Distribution | Primary stress case |
| --- | --- | --- | --- |
| `automizer-charts/template.pptx` | MIT | Deterministically curated derivative | Native charts, filled placeholders, and overlap-free chart chrome |
| `automizer-tables/template.pptx` | MIT | Exact upstream binary | Eight native tables and filled placeholders |
| `martin/template.pptx` | MIT | Exact upstream binary | Empty native title/body placeholders and inherited formatting |
| `cats/template.pptx` | CC0-1.0 | Deterministically sanitized derivative | 33-slide, image- and hyperlink-heavy preservation-only round trip |

`manifest.json` is the machine-readable provenance and target contract. Binary
SHA-256 values are binding: a changed source must be reviewed as a new fixture
version. The corrupted TRIPLE candidate is intentionally not vendored; its
rejection evidence is recorded in `rejected/triple.json`. The structurally valid
Keith CC0 candidate is retained as a rejected diagnostic because real PowerPoint
repeatedly terminated during serialization; it is not counted as healthy proof.

The Cats upstream binary is vendored and hash-pinned. Rebuild its curated fixture with:

```powershell
python fixtures/template/c10-v1/cats/sanitize.py `
  --input fixtures/template/c10-v1/cats/upstream-template.pptx `
  --output fixtures/template/c10-v1/cats/template.pptx
```

The Automizer chart upstream binary is vendored and hash-pinned. Rebuild its curated
fixture with:

```powershell
python fixtures/template/c10-v1/automizer-charts/sanitize.py `
  fixtures/template/c10-v1/automizer-charts/upstream-template.pptx `
  fixtures/template/c10-v1/automizer-charts/template.pptx
```
