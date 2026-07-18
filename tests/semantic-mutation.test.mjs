import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exactPathInventoryMatches } from "../scripts/lib/semantic-surface-evidence.mjs";
import {
  RENDERED_HEADER_NEGATIVE_EXPECTATIONS,
  SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS,
  allTrue,
  allTrueExact,
  expectedMutationCommandPlan,
  expectedSemanticMutationReceiptPaths,
  validateMutationCaseState,
  validateNativeReadability,
  validateCommandReceiptBytes,
  validateRenderMeasurementChart,
  publishSemanticMutationEvidence,
  readRasterDimensions,
  validateNegativeSummaryHeader,
  validateOwnedPowerPointRuntimeReceipt,
  validateRenderedHeaderNegativeControls,
  validateSemanticMutationCommandReceipts,
  validateSemanticMutationQuiescenceEvidence,
} from "../scripts/lib/semantic-mutation-evidence.mjs";

const contractPath = new URL("../fixtures/semantic-surface/v1/mutation-contract.json", import.meta.url);
const mutationWorkerPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_semantic_mutation.ps1", import.meta.url);
const renderWorkerPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_render_isolated.ps1", import.meta.url);
const mutationAuditPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_mutation.py", import.meta.url);
const renderedHeaderAuditPath = path.resolve("plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_rendered_headers.py");
const negativeControlsPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/semantic_mutation_negative_controls.py", import.meta.url);
const runnerPath = new URL("../scripts/run-semantic-mutation-benchmark.mjs", import.meta.url);
const reviewFinalizerPath = new URL("../scripts/finalize-semantic-mutation-review.mjs", import.meta.url);
const evidencePath = new URL("../scripts/lib/semantic-mutation-evidence.mjs", import.meta.url);
const verifierPath = new URL("../scripts/verify-semantic-mutation-evidence.mjs", import.meta.url);
const reviewVerifierPath = new URL("../scripts/verify-semantic-mutation-review.mjs", import.meta.url);

async function readContract() {
  return JSON.parse(await fs.readFile(contractPath, "utf8"));
}

test("C18 mutation contract is source-bound and explicitly narrow", async () => {
  const contract = await readContract();
  assert.equal(contract.schemaVersion, "slidewright-semantic-mutation/v1");
  assert.match(contract.scope, /not arbitrary existing-deck ingestion/i);
  const baseline = new URL(`../${contract.baselineContract.path}`, import.meta.url);
  const digest = crypto.createHash("sha256").update(await fs.readFile(baseline)).digest("hex");
  assert.equal(digest, contract.baselineContract.sha256);
  assert.equal(contract.baselineContract.powerPointNormalizedBaselineRequired, true);
  assert.equal(contract.realPowerPointRequired, true);
  assert.equal(contract.saveReopenRequired, true);
});

test("C18 mutation matrix covers two chart directions, table cells, diagrams, and connectors", async () => {
  const contract = await readContract();
  assert.deepEqual(contract.cases.map((item) => item.id), [
    "horizontal-chart-data",
    "vertical-chart-data",
    "table-cell-edit",
    "diagram-node-move",
    "connector-style-geometry",
  ]);
  const operations = new Set(contract.cases.map((item) => item.operation));
  for (const operation of ["replace-chart-data", "replace-table-cell", "move-diagram-node", "edit-connector-style"]) {
    assert.ok(operations.has(operation));
  }
  assert.deepEqual(contract.cases.slice(0, 2).map((item) => item.expected.direction), ["bar", "column"]);
  assert.ok(contract.cases.every((item) => item.allowedChangedObjects.includes(item.target)));
  assert.equal(contract.cases.find((item) => item.id === "table-cell-edit").cell.after, "Verified");
  assert.deepEqual(contract.cases.find((item) => item.id === "diagram-node-move").attachedConnectors, [
    "surface-04-connector-a", "surface-04-connector-b",
  ]);
});

test("C18 readability floors and destructive controls are binary", async () => {
  const contract = await readContract();
  assert.equal(contract.readability.charts.minimumLabelFontPoints, 12);
  assert.equal(contract.readability.tables.minimumCellFontPoints, 14);
  assert.equal(contract.readability.diagrams.connectorsMustRemainAttached, true);
  const numericValues = [
    contract.readability.charts.minimumFramePoints.width,
    contract.readability.charts.minimumFramePoints.height,
    contract.readability.charts.minimumLabelFontPoints,
    contract.readability.charts.maximumCategories,
    contract.readability.charts.maximumSeries,
    contract.readability.tables.minimumCellFontPoints,
    contract.readability.diagrams.minimumLineWeightPoints,
  ];
  assert.ok(numericValues.every(Number.isInteger));
  assert.deepEqual(contract.negativeControls, [
    "stale-baseline-hash",
    "unauthorized-object-mutation",
    "chart-flatten",
    "chart-label-unreadable",
    "table-flatten",
    "table-cell-overflow",
    "connector-detach",
    "connector-crosses-label",
    "diagram-label-outside-node",
  ]);
  assert.equal(contract.visualReview.inspectEverySlideAtFullSize, true);
  assert.equal(contract.visualReview.requiredDecks.length, 6);
});

test("C18 PowerPoint worker uses native mutation APIs and non-destructive session cleanup", async () => {
  const source = await fs.readFile(mutationWorkerPath, "utf8");
  assert.match(source, /SeriesCollection\(1\)/);
  assert.match(source, /\.XValues =/);
  assert.match(source, /\.Values =/);
  assert.match(source, /\$table\.Cell\(/);
  assert.match(source, /\$connectorFormat\.BeginConnectedShape/);
  assert.match(source, /\$line\.DashStyle =/);
  assert.match(source, /\.SaveAs\(\$outputDeck, 24\)/);
  assert.match(source, /Open-Presentation \$powerPoint \$outputDeck \$true/);
  assert.match(source, /GetWindowThreadProcessId/);
  assert.match(source, /\/AUTOMATION/);
  assert.match(source, /ownedPresentationPaths/);
  assert.match(source, /Test-EmptyHiddenApplication/);
  assert.match(source, /mutationContractSha256/);
  assert.match(source, /dataLabels = \$dataLabelRecords/);
  assert.match(source, /Release-ComReference/);
  assert.doesNotMatch(source, /\.Quit\(\)|Stop-Process|Get-Process[^\n]*\.Kill\(/);
});

test("C18 auditor fails closed without source-bound rendered readability evidence", async () => {
  const source = await fs.readFile(mutationAuditPath, "utf8");
  assert.match(source, /slidewright-semantic-mutation-render-evidence\/v1/);
  assert.match(source, /--measure-render/);
  assert.match(source, /--render-evidence/);
  assert.match(source, /inputPptxSha256/);
  assert.match(source, /minimumMarkThicknessPixels/);
  assert.match(source, /labelsInBounds/);
  assert.match(source, /labelsNoOverlap/);
  assert.match(source, /PowerPoint report lacks save\/reopen or native readability metrics/);
  assert.match(source, /SM010/);
});

test("C18 destructive controls require their intended auditor failure codes", async () => {
  const source = await fs.readFile(negativeControlsPath, "utf8");
  for (const code of ["SM001", "SM002", "SM004", "SM005", "SM006", "SM007", "SM008", "SM009"]) {
    assert.match(source, new RegExp(code));
  }
  assert.match(source, /--render-evidence/);
  assert.match(source, /intendedFailureCodes/);
  assert.match(source, /return_code == 2/);
  assert.match(source, /"table-cell-overflow": \("SM008",\)/);
  assert.doesNotMatch(source, /"table-cell-overflow": \("SM003"/);
});

test("C18 auditor masks only declared OOXML leaves and fails closed without PowerPoint", () => {
  const python = process.env.SLIDEWRIGHT_PYTHON || "python";
  const script = String.raw`
import copy
import sys
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root / "plugins" / "slidewright" / "skills" / "slidewright" / "scripts" / "semantic_surface"))
import audit_semantic_mutation as audit

assert audit.DASH_STYLE_TO_OOXML[4] == "dash"
assert audit.DASH_STYLE_TO_OOXML[5] == "dashDot"

chart_a = b'''<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>Before</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></c:spPr><c:cat><c:strLit><c:pt idx="0"><c:v>A</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'''
chart_data_only = chart_a.replace(b'Before', b'After').replace(b'<c:v>A</c:v>', b'<c:v>B</c:v>').replace(b'<c:v>1</c:v>', b'<c:v>2</c:v>')
chart_style_drift = chart_data_only.replace(b'112233', b'445566')
assert audit.normalized_chart_part(chart_a) == audit.normalized_chart_part(chart_data_only)
assert audit.normalized_chart_part(chart_a) != audit.normalized_chart_part(chart_style_drift)

slide = b'''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="surface-04-structure"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="2" name="surface-04-structure-text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="120" y="220"/><a:ext cx="200" cy="100"/></a:xfrm></p:spPr></p:sp><p:cxnSp><p:nvCxnSpPr><p:cNvPr id="3" name="surface-04-connector-a"/><p:cNvCxnSpPr><a:stCxn id="9" idx="1"/><a:endCxn id="1" idx="2"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:ln w="12700"/></p:spPr></p:cxnSp><p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="surface-04-connector-b"/><p:cNvCxnSpPr><a:stCxn id="1" idx="3"/><a:endCxn id="10" idx="4"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="300" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:ln w="12700"/></p:spPr></p:cxnSp></p:spTree></p:cSld></p:sld>'''
move_case = {"operation":"move-diagram-node","target":"surface-04-structure","moveWithTarget":["surface-04-structure-text"],"attachedConnectors":["surface-04-connector-a","surface-04-connector-b"]}
moved = slide.replace(b'x="100" y="200"', b'x="100" y="500"').replace(b'x="120" y="220"', b'x="120" y="520"').replace(b'x="0" y="0"', b'x="1" y="2"').replace(b'x="300" y="0"', b'x="301" y="2"')
wrong_site = moved.replace(b'idx="3"', b'idx="7"')
mirrored_node = moved.replace(b'<a:xfrm>', b'<a:xfrm flipH="1">', 1)
assert audit.normalized_slide_part(slide, move_case) == audit.normalized_slide_part(moved, move_case)
assert audit.normalized_slide_part(slide, move_case) != audit.normalized_slide_part(wrong_site, move_case)
assert audit.normalized_slide_part(slide, move_case) != audit.normalized_slide_part(mirrored_node, move_case)

baseline_parts = {"ppt/slides/slide2.xml": b'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>', "ppt/charts/chart1.xml": chart_a, "ppt/theme/theme1.xml": b'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="safe"/>'}
variant_parts = dict(baseline_parts)
variant_parts["ppt/charts/chart1.xml"] = chart_data_only
chart_case = {"operation":"replace-chart-data","target":"chart","slide":2}
inventory = {"chart":{"relationshipTarget":"ppt/charts/chart1.xml"}}
closure = audit.compare_operation_closure(baseline_parts, variant_parts, inventory, inventory, chart_case)
assert closure["valid"] is True
variant_parts["ppt/theme/theme1.xml"] = b'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="drift"/>'
assert audit.compare_operation_closure(baseline_parts, variant_parts, inventory, inventory, chart_case)["valid"] is False

table_xml = '''<p:graphicFrame xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1828800"/></a:tblGrid><a:tr h="762000"><a:tc><a:txBody><a:bodyPr wrap="none"/><a:p><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p></a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'''
from xml.etree import ElementTree as ET
assert audit.table_details(ET.fromstring(table_xml.format("Verified")))["cells"][0]["staticFits"] is True
assert audit.table_details(ET.fromstring(table_xml.format("W" * 320)))["cells"][0]["staticFits"] is False

table_slide = '''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p:cSld><p:spTree><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="12" name="surface-03-table"/><p:cNvGraphicFramePr/><p:nvPr>{}</p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1828800"/></a:tblGrid><a:tr h="762000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr {} sz="1500"><a:solidFill><a:srgbClr val="172033"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r>{}</a:p></a:txBody><a:tcPr marL="152400" marR="152400" marT="95250" marB="95250"/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:sp><p:nvSpPr><p:cNvPr id="13" name="unrelated"/><p:cNvSpPr/><p:nvPr>{}</p:nvPr></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:cSld></p:sld>'''
table_case = {"operation":"replace-table-cell","target":"surface-03-table","slide":3,"cell":{"row":1,"column":1}}
baseline_table_slide = table_slide.format("", "", "Exact", "", "")
powerpoint_bookkeeping = '<p:extLst><p:ext uri="{D42A27DB-BD31-4B8C-83A1-F6EECF244321}"><p14:modId val="2995016105"/></p:ext></p:extLst>'
redundant_end_style = '<a:endParaRPr sz="1500"><a:solidFill><a:srgbClr val="172033"/></a:solidFill></a:endParaRPr>'
powerpoint_table_slide = table_slide.format(powerpoint_bookkeeping, 'lang="de-DE"', "Verified", redundant_end_style, "")
assert audit.normalized_slide_part(baseline_table_slide.encode(), table_case) == audit.normalized_slide_part(powerpoint_table_slide.encode(), table_case)
visible_style_drift = table_slide.format(powerpoint_bookkeeping, 'lang="de-DE"', "Verified", redundant_end_style.replace('sz="1500"', 'sz="1400"'), "")
assert audit.normalized_slide_part(baseline_table_slide.encode(), table_case) != audit.normalized_slide_part(visible_style_drift.encode(), table_case)
unrelated_mod_id = table_slide.format("", "", "Verified", "", powerpoint_bookkeeping)
assert audit.normalized_slide_part(baseline_table_slide.encode(), table_case) != audit.normalized_slide_part(unrelated_mod_id.encode(), table_case)

good_labels = [{"index":1,"text":"36","leftPoints":10,"topPoints":10,"widthPoints":20,"heightPoints":10},{"index":2,"text":"28","leftPoints":40,"topPoints":10,"widthPoints":20,"heightPoints":10}]
assert audit.powerpoint_label_checks(good_labels, [36,28], 100, 50)[:3] == (True, True, True)
outside = copy.deepcopy(good_labels); outside[1]["leftPoints"] = 90
assert audit.powerpoint_label_checks(outside, [36,28], 100, 50)[0] is False
overlap = copy.deepcopy(good_labels); overlap[1]["leftPoints"] = 15
assert audit.powerpoint_label_checks(overlap, [36,28], 100, 50)[1] is False

baseline_contract = {"slides":[{"charts":[{"name":"chart","categories":["A"],"series":[{"name":"S","values":[1]}]}]}]}
baseline_inventory = {"node":{"geometry":{"x":127000,"y":254000}}, "connector":{"geometry":{}}}
state_cases = [
 ({"id":"chart-case","operation":"replace-chart-data","target":"chart","expected":{"categories":["B"],"series":[{"name":"S","values":[2]}]}}, {"before":{"name":"S","categories":["A"],"values":[1]},"afterMutation":{"name":"S","categories":["B"],"values":[2]},"afterSaveReopen":{"name":"S","categories":["B"],"values":[2]}}),
 ({"id":"table-case","operation":"replace-table-cell","cell":{"before":"Exact","after":"Verified"}}, {"before":"Exact","afterMutation":"Verified","afterSaveReopen":"Verified"}),
 ({"id":"move-case","operation":"move-diagram-node","target":"node","deltaPoints":{"x":0,"y":24}}, {"before":{"left":10,"top":20},"afterMutation":{"left":10,"top":44},"afterSaveReopen":{"left":10,"top":44}}),
 ({"id":"connector-case","operation":"edit-connector-style","expected":{"weightPoints":3,"dashStyle":4},"attachedEndpoints":{"from":"A","to":"B"}}, {"before":{"weightPoints":3,"dashStyle":1},"afterMutation":{"weightPoints":3,"dashStyle":4,"from":"A","to":"B"},"afterSaveReopen":{"weightPoints":3,"dashStyle":4,"from":"A","to":"B"}}),
]
for mutation_case, result in state_cases:
 failures = []
 audit.validate_powerpoint_case_state(result, mutation_case, baseline_contract, baseline_inventory, failures)
 assert failures == [], (mutation_case, failures)
 broken = copy.deepcopy(result)
 broken["afterSaveReopen"] = None
 audit.validate_powerpoint_case_state(broken, mutation_case, baseline_contract, baseline_inventory, failures)
 assert failures[-1]["code"] == "SM011"

closed = audit.measure_render(Path("definitely-missing.pptx"), Path("definitely-missing.png"), "case")
assert closed["valid"] is False and closed["failures"][0]["code"] == "SM010"
print("semantic mutation no-PowerPoint guarantees passed")
`;
  const result = spawnSync(python, ["-c", script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /no-PowerPoint guarantees passed/);
});

test("C18 runner renders before measuring, auditing, and destructive controls", async () => {
  const source = await fs.readFile(runnerPath, "utf8");
  assert.match(source, /copiedBaselinePptxSha256: copiedBaselineSha256/u);
  const mutation = source.indexOf("powerpoint_semantic_mutation.ps1");
  const renders = source.indexOf("const renderEvidence = []");
  const measures = source.indexOf('"--measure-render"');
  const audits = source.indexOf('"--render-evidence"');
  const negatives = source.indexOf("negativeControlsScript,", audits);
  const overflow = source.indexOf("const overflowChecks = []");
  assert.ok(mutation >= 0 && mutation < renders && renders < measures && measures < audits && audits < negatives && negatives < overflow);
  assert.match(source, /semantic-surface["']?,[\s\S]*current\.json/);
  assert.match(source, /powerpoint-roundtrip\.pptx/);
  assert.match(source, /requires a current hardened C08 baseline/);
  assert.match(source, /refusing to publish evidence against a superseded baseline/);
  assert.match(source, /slidewright-semantic-surface-scorecard\/v2/);
  assert.match(source, /verifySemanticSurfaceEvidence/);
});

test("C18 runtime capture uses an exact ownership handshake instead of a timing sleep", async () => {
  const [runner, mutationWorker, renderWorker] = await Promise.all([
    fs.readFile(runnerPath, "utf8"),
    fs.readFile(mutationWorkerPath, "utf8"),
    fs.readFile(renderWorkerPath, "utf8"),
  ]);
  assert.match(runner, /slidewright-runtime-capture-ack\/v1/u);
  assert.match(runner, /runtimeReceiptSha256/u);
  assert.match(runner, /\$\{ownershipRecordPath\}\.runtime-captured/u);
  for (const worker of [mutationWorker, renderWorker]) {
    assert.match(worker, /slidewright-runtime-capture-ack\/v1/u);
    assert.match(worker, /processStartTime -eq \[string\]\$record\.processStartTime/u);
    assert.match(worker, /Timed out waiting for runtime capture of owned PowerPoint process/u);
  }
});

test("C18 receipt inventory is exact and rejects additions or removals", async () => {
  const contract = await readContract();
  const paths = expectedSemanticMutationReceiptPaths(contract);
  assert.equal(paths.length, new Set(paths).size);
  for (const required of [
    "command-log.json",
    "powerpoint-interstage-quiescence.json",
    "powerpoint-runtime/native-mutation.json",
    "watchdog/normal/identity-receipt.json",
    "watchdog/normal/ready.marker",
    "watchdog/normal/completion.marker",
    "watchdog/normal/diagnostic.log",
    "watchdog/normal/summary.json",
    "mutations/horizontal-chart-data.pptx",
    "renders/connector-style-geometry/slide-04.png",
    "negative-controls/table-cell-overflow/audit.json",
    "rendered-header-contract.json",
    "rendered-header-evidence.json",
    "implementation-snapshot/scripts/lib/semantic-mutation-evidence.mjs",
  ]) assert.ok(paths.includes(required), required);
  const historicalPaths = expectedSemanticMutationReceiptPaths(contract, 0, ["fixtures/semantic-surface/v1/mutation-contract.json"]);
  assert.ok(historicalPaths.includes("implementation-snapshot/fixtures/semantic-surface/v1/mutation-contract.json"));
  assert.equal(historicalPaths.some((item) => item === "implementation-snapshot/scripts/lib/semantic-mutation-evidence.mjs"), false);
  assert.equal(exactPathInventoryMatches(paths, paths), true);
  assert.equal(exactPathInventoryMatches(paths.slice(1), paths), false);
  assert.equal(exactPathInventoryMatches([...paths, "undeclared.txt"], paths), false);
});

test("C18 independently derives PNG and JPEG pixel dimensions", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c18-images-"));
  try {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.writeUInt32BE(1600, 16); png.writeUInt32BE(900, 20);
    const jpeg = Buffer.alloc(21);
    jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff; jpeg[3] = 0xc0; jpeg.writeUInt16BE(17, 4); jpeg[6] = 8; jpeg.writeUInt16BE(900, 7); jpeg.writeUInt16BE(1600, 9);
    const pngPath = path.join(temporary, "slide.png");
    const jpegPath = path.join(temporary, "slide.jpg");
    await Promise.all([fs.writeFile(pngPath, png), fs.writeFile(jpegPath, jpeg)]);
    assert.deepEqual(await readRasterDimensions(pngPath), { format: "png", width: 1600, height: 900 });
    assert.deepEqual(await readRasterDimensions(jpegPath), { format: "jpeg", width: 1600, height: 900 });
    png.writeUInt32BE(899, 20); await fs.writeFile(pngPath, png);
    assert.deepEqual(await readRasterDimensions(pngPath), { format: "png", width: 1600, height: 899 });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("C18 rendered-header audit proves all 48 prefixes and rejects erased pixels", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c18-headers-"));
  try {
    const decks = ["powerpoint-normalized-baseline", "horizontal-chart-data", "vertical-chart-data", "table-cell-edit", "diagram-node-move", "connector-style-geometry"];
    const generator = String.raw`
from PIL import Image, ImageDraw
from pathlib import Path
import hashlib, json, sys
root=Path(sys.argv[1]); decks=json.loads(sys.argv[2]); contract={"schemaVersion":"slidewright-rendered-header-contract/v1","decks":[]}
for deck in decks:
  folder=root/deck; folder.mkdir(parents=True,exist_ok=True); renders=[]
  for slide in range(1,5):
    image=Image.new("RGB",(1600,900),"white"); draw=ImageDraw.Draw(image)
    for glyph in range(16):
      left=81+glyph*17; draw.rectangle((left,61,left+6,77),fill=(47,107,255))
    png=folder/f"slide-{slide:02}.png"; jpg=folder/f"slide-{slide:02}.jpg"; image.save(png); image.save(jpg,quality=92)
    sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    renders.append({"slide":slide,"file":png.name,"sha256":sha(png),"reviewFile":jpg.name,"reviewSha256":sha(jpg)})
  contract["decks"].append({"id":deck,"renders":renders})
reference=root.parent/"reference"; reference.mkdir(); first=contract["decks"][0]["renders"][0]
for key in ("file","reviewFile"):
  source=root/decks[0]/first[key]; target=reference/source.name; target.write_bytes(source.read_bytes())
contract["reference"]={"semanticSurfaceScorecardHash":"a"*64,"file":first["file"],"sha256":first["sha256"],"reviewFile":first["reviewFile"],"reviewSha256":first["reviewSha256"]}
(root.parent/"contract.json").write_text(json.dumps(contract),encoding="utf-8")
`;
    const generated = spawnSync("python", ["-c", generator, path.join(temporary, "renders"), JSON.stringify(decks)], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const reportPath = path.join(temporary, "report.json");
    const runAudit = () => spawnSync("python", [renderedHeaderAuditPath, "--contract", path.join(temporary, "contract.json"), "--renders-root", path.join(temporary, "renders"), "--reference-renders-root", path.join(temporary, "reference"), "--json", reportPath], { encoding: "utf8" });
    let result = runAudit();
    assert.equal(result.status, 0, result.stderr);
    let report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.valid, true);
    assert.equal(report.imageCount, 48);
    assert.equal(report.records.length, 48);
    assert.equal(report.negativeControls.length, 4);
    assert.equal(validateRenderedHeaderNegativeControls(report.negativeControls), true);
    assert.deepEqual(report.negativeControls.map((item) => item.id), Object.keys(RENDERED_HEADER_NEGATIVE_EXPECTATIONS));
    assert.throws(() => validateRenderedHeaderNegativeControls([...report.negativeControls].reverse()), /identity drifted/);
    const missingIntendedFailure = structuredClone(report.negativeControls);
    missingIntendedFailure[0].failureChecks = missingIntendedFailure[0].failureChecks.filter((item) => item !== "pixelCount");
    assert.throws(() => validateRenderedHeaderNegativeControls(missingIntendedFailure), /did not reject the intended pixelCount defect/);

    const tamper = String.raw`
from PIL import Image,ImageDraw
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1]); image=Image.open(p).convert("RGB"); ImageDraw.Draw(image).rectangle((70,50,170,85),fill="white"); image.save(p)
c=Path(sys.argv[2]); data=json.loads(c.read_text()); data["decks"][0]["renders"][0]["sha256"]=hashlib.sha256(p.read_bytes()).hexdigest(); c.write_text(json.dumps(data))
`;
    const tampered = spawnSync("python", ["-c", tamper, path.join(temporary, "renders", decks[0], "slide-01.png"), path.join(temporary, "contract.json")], { encoding: "utf8" });
    assert.equal(tampered.status, 0, tampered.stderr);
    result = runAudit();
    assert.equal(result.status, 2);
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.valid, false);
    assert.ok(report.failures.some((item) => ["RH003", "RH004"].includes(item.code)));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function receipt(command, args, { timedOut = false, exitCode = 0 } = {}) {
  return { command, args, exitCode, signal: null, timedOut, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) };
}

function pollReceipt() {
  return receipt("powershell", ["-NoProfile", "-Command", "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0"]);
}

test("C18 command receipts bind exact argv, staging path, and nine quiescence gates", async () => {
  const contract = await readContract();
  const output = "<repo>/outputs/semantic-mutation/runs/.staging-123-456";
  const plan = expectedMutationCommandPlan(output, "<external>/python.exe", contract);
  const commands = [pollReceipt(), pollReceipt()];
  commands.push(receipt(plan[0].command, plan[0].args, { timedOut: true, exitCode: null }));
  commands.push(receipt(plan[1].command, plan[1].args));
  commands.push(pollReceipt(), pollReceipt());
  for (const descriptor of plan.slice(2, 8)) {
    commands.push(receipt(descriptor.command, descriptor.args), pollReceipt(), pollReceipt());
  }
  for (const descriptor of plan.slice(8)) commands.push(receipt(descriptor.command, descriptor.args));
  commands.push(pollReceipt(), pollReceipt());
  const log = { schemaVersion: "slidewright-command-receipts/v1", logicalCommand: "npm run semantic-mutation", commands };
  assert.equal(validateSemanticMutationCommandReceipts(log, contract), true);
  const extraFlag = structuredClone(log);
  const mutation = extraFlag.commands.find((item) => item.args.some((arg) => arg.endsWith("/powerpoint_semantic_mutation.ps1")));
  mutation.args.push("--evil-unexpected");
  assert.throws(() => validateSemanticMutationCommandReceipts(extraFlag, contract), /unexpected command or argv sequence/u);
  const missingPoll = structuredClone(log);
  missingPoll.commands.splice(0, 1);
  assert.throws(() => validateSemanticMutationCommandReceipts(missingPoll, contract), /nine two-poll|sequence drifted/u);
  const wrongPath = structuredClone(log);
  const timeout = wrongPath.commands.find((item) => item.args.some((arg) => arg.endsWith("/powerpoint_timeout_probe.ps1")));
  timeout.args[timeout.args.indexOf("-OwnershipRecordJson") + 1] = `${output}/wrong.json`;
  assert.throws(() => validateSemanticMutationCommandReceipts(wrongPath, contract), /exact staging output path/u);
});

test("C18 receipt inventory binds raw output bytes for every command", async () => {
  const contract = await readContract();
  const paths = expectedSemanticMutationReceiptPaths(contract, 3);
  for (let index = 1; index <= 3; index += 1) {
    const sequence = String(index).padStart(4, "0");
    assert.ok(paths.includes(`command-receipts/${sequence}.stdout.txt`));
    assert.ok(paths.includes(`command-receipts/${sequence}.stderr.txt`));
  }
  assert.equal(paths.filter((item) => item.startsWith("command-receipts/")).length, 6);
});

test("C18 raw command receipts and rendered mark measurements fail closed", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c18-receipts-"));
  try {
    const stdoutPath = "command-receipts/0001.stdout.txt";
    const stderrPath = "command-receipts/0001.stderr.txt";
    await fs.mkdir(path.join(temporary, "command-receipts"));
    await Promise.all([fs.writeFile(path.join(temporary, ...stdoutPath.split("/")), "clear\n"), fs.writeFile(path.join(temporary, ...stderrPath.split("/")), "")]);
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const log = { commands: [{ command: "python", args: ["tool.py"], stdoutPath, stderrPath, stdoutSha256: hash("clear\n"), stderrSha256: hash("") }] };
    const raw = await validateCommandReceiptBytes((relative) => path.join(temporary, ...relative.split("/")), log);
    assert.equal(raw[0].stdout, "clear\n");
    const pollArgs = ["-NoProfile", "-Command", "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0"];
    for (let index = 2; index <= 4; index += 1) {
      const sequence = String(index).padStart(4, "0");
      const pollStdout = index === 2 ? "1234\n" : "";
      const pollStdoutPath = `command-receipts/${sequence}.stdout.txt`;
      const pollStderrPath = `command-receipts/${sequence}.stderr.txt`;
      await Promise.all([fs.writeFile(path.join(temporary, ...pollStdoutPath.split("/")), pollStdout), fs.writeFile(path.join(temporary, ...pollStderrPath.split("/")), "")]);
      log.commands.push({ command: "powershell", args: pollArgs, stdoutPath: pollStdoutPath, stderrPath: pollStderrPath, stdoutSha256: hash(pollStdout), stderrSha256: hash("") });
    }
    await validateCommandReceiptBytes((relative) => path.join(temporary, ...relative.split("/")), log);
    await fs.writeFile(path.join(temporary, ...stdoutPath.split("/")), "tampered\n");
    await assert.rejects(() => validateCommandReceiptBytes((relative) => path.join(temporary, ...relative.split("/")), log), /raw-output bytes drifted/u);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  const rules = { minimumMarkThicknessPixels: 8 };
  const valid = { framePixels: { left: 0, top: 0, right: 200, bottom: 100 }, expectedMarkCount: 2, detectedMarkCount: 2, minimumMarkThicknessPixels: 8, labelsDetected: true, labelPresenceProbeRegions: [{ left: 10, top: 10, right: 30, bottom: 30 }, { left: 40, top: 10, right: 60, bottom: 30 }], labelDarkPixelCounts: [1, 2] };
  assert.equal(validateRenderMeasurementChart(valid, rules, "case"), true);
  assert.throws(() => validateRenderMeasurementChart({ ...valid, expectedMarkCount: 0, detectedMarkCount: 0, labelPresenceProbeRegions: [], labelDarkPixelCounts: [] }, rules, "case"), /measurement is incomplete/u);
  assert.throws(() => validateRenderMeasurementChart({ ...valid, minimumMarkThicknessPixels: 7 }, rules, "case"), /measurement is incomplete/u);
  const outside = structuredClone(valid); outside.labelPresenceProbeRegions[1].right = 220;
  assert.throws(() => validateRenderMeasurementChart(outside, rules, "case", { width: 200, height: 100, expectedMarkCount: 2 }), /escaped its frame/u);
  const overlap = structuredClone(valid); overlap.labelPresenceProbeRegions[1] = { left: 20, top: 20, right: 50, bottom: 40 };
  assert.throws(() => validateRenderMeasurementChart(overlap, rules, "case"), /probes overlap/u);
});

test("C18 verifier rejects empty check maps and binds exact operation states", () => {
  assert.equal(allTrue({}), false);
  assert.equal(allTrue({ a: true, b: true }), true);
  assert.equal(allTrue({ a: true, b: false }), false);
  assert.equal(allTrueExact({ a: true }, ["a"]), true);
  assert.equal(allTrueExact({ madeUp: true }, ["a"]), false);
  const cases = [
    [{ id: "chart", operation: "replace-chart-data", expected: { categories: ["A"], series: [{ name: "S", values: [2] }] } }, { id: "chart", afterMutation: { name: "S", categories: ["A"], values: [2] }, afterSaveReopen: { name: "S", categories: ["A"], values: [2] } }],
    [{ id: "table", operation: "replace-table-cell", cell: { before: "Exact", after: "Verified" } }, { id: "table", before: "Exact", afterMutation: "Verified", afterSaveReopen: "Verified" }],
    [{ id: "diagram", operation: "move-diagram-node", deltaPoints: { x: 0, y: 24 } }, { id: "diagram", before: { left: 10, top: 20 }, afterMutation: { left: 10, top: 44 }, afterSaveReopen: { left: 10, top: 44 } }],
    [{ id: "connector", operation: "edit-connector-style", expected: { weightPoints: 3, dashStyle: 4 }, attachedEndpoints: { from: "A", to: "B" } }, { id: "connector", afterMutation: { weightPoints: 3, dashStyle: 4, from: "A", to: "B" }, afterSaveReopen: { weightPoints: 3, dashStyle: 4, from: "A", to: "B" } }],
  ];
  for (const [mutationCase, result] of cases) {
    assert.equal(validateMutationCaseState(result, mutationCase), true);
    const broken = structuredClone(result);
    broken.afterSaveReopen = null;
    assert.throws(() => validateMutationCaseState(broken, mutationCase), /mutation state drifted/u);
  }
});

test("C18 publisher restores prior pointers when post-publication verification fails", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c18-publish-"));
  try {
    const published = path.join(temporary, "published");
    const staging = path.join(temporary, "staging");
    await fs.mkdir(published, { recursive: true });
    await fs.mkdir(staging, { recursive: true });
    const priorCurrent = "prior-current\n";
    const priorScorecard = "prior-scorecard\n";
    await Promise.all([fs.writeFile(path.join(published, "current.json"), priorCurrent), fs.writeFile(path.join(published, "scorecard.json"), priorScorecard)]);
    await fs.writeFile(path.join(staging, "scorecard.json"), JSON.stringify({ scorecardHash: "new-run" }));
    let calls = 0;
    await assert.rejects(() => publishSemanticMutationEvidence({ staging, published, scorecardHash: "new-run", verify: async () => { calls += 1; if (calls === 3) throw new Error("post-pointer failure"); } }), /post-pointer failure/u);
    assert.equal(await fs.readFile(path.join(published, "current.json"), "utf8"), priorCurrent);
    assert.equal(await fs.readFile(path.join(published, "scorecard.json"), "utf8"), priorScorecard);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("C18 verifier rederives native chart labels and table cells from the contracts", () => {
  const baseline = { slides: [
    { index: 2, charts: [
      { name: "bar", categories: ["A"], series: [{ name: "S", values: [1] }] },
      { name: "column", categories: ["B"], series: [{ name: "T", values: [3] }] },
    ] },
    { index: 3, table: { name: "table", rows: 1, columns: 1, values: [["Exact"]] } },
  ] };
  const rules = {
    charts: { minimumFramePoints: { width: 240, height: 160 }, maximumCategories: 12, maximumSeries: 6, minimumLabelFontPoints: 12 },
    tables: { minimumCellFontPoints: 14 },
  };
  const mutationCase = { id: "chart", operation: "replace-chart-data", target: "bar", expected: { series: [{ values: [2] }] } };
  const chart = (name, text) => ({ name, widthPoints: 300, heightPoints: 200, categoryCount: 1, seriesCount: 1, categoryAxisFontPoints: 12, valueAxisFontPoints: 12, dataLabelFontPoints: 12, dataLabels: [{ index: 1, text, leftPoints: 10, topPoints: 10, widthPoints: 20, heightPoints: 10 }] });
  const result = { readability: {
    charts: [chart("bar", "2"), chart("column", "3")],
    table: { name: "table", rows: 1, columns: 1, cells: [{ row: 1, column: 1, text: "Exact", fontPoints: 14, marginLeftPoints: 5, marginRightPoints: 5, marginTopPoints: 4, marginBottomPoints: 4, fits: true }] },
  } };
  assert.equal(validateNativeReadability(result, mutationCase, baseline, rules), true);
  const wrongLabel = structuredClone(result); wrongLabel.readability.charts[0].dataLabels[0].text = "999";
  assert.throws(() => validateNativeReadability(wrongLabel, mutationCase, baseline, rules), /label bounds or text drifted/u);
  const wrongMargin = structuredClone(result); wrongMargin.readability.table.cells[0].marginRightPoints = 6;
  assert.throws(() => validateNativeReadability(wrongMargin, mutationCase, baseline, rules), /table cell readability drifted/u);
});

test("C18 negative controls have exact case and intended-code mappings", async () => {
  const contract = await readContract();
  assert.deepEqual(Object.keys(SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS), contract.negativeControls);
  assert.deepEqual(SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS["stale-baseline-hash"], { caseId: "horizontal-chart-data", code: "SM001" });
  assert.deepEqual(SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS["table-cell-overflow"], { caseId: "table-cell-edit", code: "SM008" });
  assert.deepEqual(SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS["connector-detach"], { caseId: "connector-style-geometry", code: "SM006" });
});

test("C18 negative summary rejects version drift and invalid positive audits", () => {
  const contract = { cases: [{ id: "case" }], negativeControls: ["control"] };
  const valid = {
    schemaVersion: "slidewright-semantic-mutation-negative-controls/v1",
    version: "semantic-mutation-negative-controls-v1",
    valid: true,
    baselineValid: true,
    positiveAudits: [{ caseId: "case", valid: true }],
    controls: [{ id: "control" }],
  };
  assert.equal(validateNegativeSummaryHeader(valid, contract), true);
  assert.throws(() => validateNegativeSummaryHeader({ ...valid, version: "forged" }, contract), /inventory drifted/u);
  const invalidPositive = structuredClone(valid); invalidPositive.positiveAudits[0].valid = false;
  assert.throws(() => validateNegativeSummaryHeader(invalidPositive, contract), /inventory drifted/u);
});

test("C18 runtime receipts bind every changing render-session identity in order", () => {
  const centralRuntime = { path: path.resolve("powerpoint.exe"), sha256: "f".repeat(64) };
  const processes = Array.from({ length: 5 }, (_, index) => ({
    processId: 100 + index,
    processName: "POWERPNT",
    processStartTime: `2026-07-17T00:00:0${index}.0000000Z`,
    executablePath: centralRuntime.path,
    executableSha256: centralRuntime.sha256,
  }));
  const receipt = { schemaVersion: "slidewright-owned-powerpoint-runtime/v1", processes };
  const ownership = { processId: 104, processName: "POWERPNT", processStartTime: processes[4].processStartTime };
  const sessions = processes.map((item) => ({ processId: item.processId, processStartTime: item.processStartTime }));
  assert.equal(validateOwnedPowerPointRuntimeReceipt({ receipt, ownership, centralRuntime, expectedProcessCount: 5, sessions, stage: "render" }), true);
  assert.throws(() => validateOwnedPowerPointRuntimeReceipt({ receipt: { ...receipt, processes: processes.slice(1) }, ownership, centralRuntime, expectedProcessCount: 5, sessions, stage: "render" }), /runtime receipt drifted/u);
  const reordered = [...sessions]; [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(() => validateOwnedPowerPointRuntimeReceipt({ receipt, ownership, centralRuntime, expectedProcessCount: 5, sessions: reordered, stage: "render" }), /sequence drifted/u);
});

test("C18 quiescence validator binds seven ordered stages independently of C08", async () => {
  const contract = await readContract();
  const clear = { valid: true, waitedMs: 0, polls: 2, reason: "two-consecutive-clear-polls" };
  const stages = ["after-native-mutation", ...contract.visualReview.requiredDecks.map((deck) => `after-render-${deck}`)];
  const checkpoints = stages.map((stage) => ({ stage, ...clear }));
  const valid = { initial: clear, interStage: { schemaVersion: "slidewright-powerpoint-quiescence-checkpoints/v1", valid: true, checkpoints }, scorecardInitial: clear, scorecardInterStage: checkpoints, contract, platform: "win32" };
  assert.equal(validateSemanticMutationQuiescenceEvidence(valid), true);
  assert.throws(() => validateSemanticMutationQuiescenceEvidence({ ...valid, interStage: { ...valid.interStage, checkpoints: checkpoints.slice(1) } }), /receipt is invalid/u);
  const reordered = checkpoints.map((item, index) => index === 1 ? { ...item, stage: "forged" } : item);
  assert.throws(() => validateSemanticMutationQuiescenceEvidence({ ...valid, interStage: { ...valid.interStage, checkpoints: reordered }, scorecardInterStage: reordered }), /sequence drifted/u);
});

test("C18 runner verifies immutable evidence before advancing current", async () => {
  const [runner, evidence, verifier] = await Promise.all([fs.readFile(runnerPath, "utf8"), fs.readFile(evidencePath, "utf8"), fs.readFile(verifierPath, "utf8")]);
  assert.match(runner, /slidewright-semantic-mutation-scorecard\/v2/);
  assert.match(runner, /captureCleanGit/);
  assert.match(runner, /captureSemanticMutationImplementation/);
  assert.match(runner, /captureSemanticMutationRuntime/);
  assert.match(runner, /collectReceiptTree/);
  assert.equal((runner.match(/verifySemanticMutationEvidence\(/gu) ?? []).length, 2);
  assert.match(runner, /publishSemanticMutationEvidence/);
  assert.doesNotMatch(runner, /publishVersionedEvidence/);
  const completion = runner.indexOf('fs.writeFile(watchdogCompletionMarker, "complete\\n"');
  const receipts = runner.indexOf("collectReceiptTree(output)");
  const scorecard = runner.indexOf('schemaVersion: "slidewright-semantic-mutation-scorecard/v2"');
  const publish = runner.indexOf("publishSemanticMutationEvidence({");
  assert.ok(completion >= 0 && completion < receipts && receipts < scorecard && scorecard < publish);
  for (const proof of ["implementation closure drifted", "Git provenance drifted", "receipt inventory drifted", "command receipt sequence drifted", "watchdog marker hashes drifted", "negative-control scorecard derivation drifted"]) {
    assert.match(evidence, new RegExp(proof));
  }
  assert.match(runner, /requireSourceCurrent: true/);
  assert.match(evidence, /validateCommandReceiptBytes/);
  assert.match(evidence, /watchdogProcessAbsentAfterCompletion/);
  assert.match(evidence, /timeout: 120_000/);
  assert.match(evidence, /historical implementation snapshot drifted/);
  assert.match(runner, /implementation-snapshot/);
  assert.match(evidence, /slidewright-owned-powerpoint-runtime\/v1/);
  assert.match(verifier, /verifySemanticMutationEvidence/);
  assert.match(verifier, /current\.json/);
  assert.match(verifier, /escaped its immutable run directory/);
  assert.match(verifier, /requireCurrentGit: false, requireSourceCurrent: false/);
});

test("C18 review finalizer binds all 24 full-size decisions to immutable render hashes", async () => {
  const [source, verifier] = await Promise.all([fs.readFile(reviewFinalizerPath, "utf8"), fs.readFile(reviewVerifierPath, "utf8")]);
  assert.match(source, /verifySemanticMutationEvidence/);
  assert.match(source, /machineVerification/);
  assert.match(source, /expected\.length !== 24/);
  assert.match(source, /pngHash !== render\.sha256/);
  assert.match(source, /reviewHash !== render\.reviewSha256/);
  assert.match(source, /decision\.verdict/);
  assert.match(source, /current-review\.json/);
  assert.ok((source.match(/verifySemanticMutationEvidence\(/gu) ?? []).length >= 2);
  assert.ok((source.match(/requireCurrentGit: false, requireSourceCurrent: false/gu) ?? []).length >= 2);
  assert.match(source, /verifySemanticMutationReview/);
  assert.match(source, /current pointer changed before review publication/);
  assert.match(source, /fs\.rm\(pointerPath/);
  assert.match(source, /priorPointer/);
  assert.match(verifier, /verifySemanticMutationReview/);
  assert.match(source, /Every persisted 1600x900 review image inspected individually at full size/);
  assert.match(source, /exactly one image per visual-tool call/);
});
