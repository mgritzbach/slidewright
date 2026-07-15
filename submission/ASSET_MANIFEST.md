# Submission asset manifest

Run `npm run submission:prepare` after `npm run release:check`. The command copies release outputs into `outputs/submission/screenshots/` and writes SHA-256 evidence to `outputs/submission/asset-manifest.json`.

| File | Purpose | Suggested caption |
| --- | --- | --- |
| `01-independent-reference.png` | Original opaque input | “An original reference image parsed without shared renderer geometry.” |
| `02-editable-reconstruction.png` | Hero/result | “23 native PowerPoint objects; zero pictures or embedded source raster.” |
| `03-horizontal-native-design.png` | Native design range | “Editable invitation, typography, shapes, and a real PowerPoint group.” |
| `04-template-before.png` | Template source | “PowerPoint-authored MIT golden template before the authorized copy edit.” |
| `05-template-after.png` | Template result | “Only two named placeholder text values changed; normalized audit found no other slide-1 content changes.” |
| `06-powerpoint-roundtrip.png` | Interoperability proof | “PowerPoint SaveAs/reopen retains the master, layout, footer, slide number, and native text.” |

Recommended Devpost order: reconstruction hero, PowerPoint edit selection, template before/after, then the evidence report. Capture the selection-handles screenshot during the narrated recording because static renderers intentionally omit editor chrome.
