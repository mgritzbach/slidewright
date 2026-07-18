# Structural PPTX ingestion

Use the structural importer when an existing `.pptx` must enter a workflow
without flattening native content:

```text
python scripts/structural_ingestion/import_structural.py import source.pptx imported.pptx --manifest structural-manifest.json
```

The command reads the OPC package into an in-memory part graph, emits a
machine-readable manifest, and writes a fresh deterministic container. The
manifest records:

- slide-to-layout-to-master-to-theme bindings;
- recursive shape hierarchy and semantic reading order;
- native text runs and run-property hashes;
- native table matrices and exact table XML hashes;
- chart relationships, cached values, formulas, and chart-part hashes;
- native shape-group diagrams and related SmartArt parts when present;
- speaker-note bindings, text, and part hashes; and
- the exact hash and byte length of every imported package part.

This is a lossless import/export boundary, not a semantic reconstruction
engine. It preserves editable OOXML parts but does not yet promise arbitrary
edits to imported charts, tables, diagrams, masters, or SmartArt. Do not claim
that broader behavior without a separate edit contract and destructive proof.

