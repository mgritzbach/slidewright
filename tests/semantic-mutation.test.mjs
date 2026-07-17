import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const contractPath = new URL("../fixtures/semantic-surface/v1/mutation-contract.json", import.meta.url);
const mutationWorkerPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_semantic_mutation.ps1", import.meta.url);
const mutationAuditPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_mutation.py", import.meta.url);
const negativeControlsPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/semantic_mutation_negative_controls.py", import.meta.url);
const runnerPath = new URL("../scripts/run-semantic-mutation-benchmark.mjs", import.meta.url);
const reviewFinalizerPath = new URL("../scripts/finalize-semantic-mutation-review.mjs", import.meta.url);

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

test("C18 review finalizer binds all 24 full-size decisions to immutable render hashes", async () => {
  const source = await fs.readFile(reviewFinalizerPath, "utf8");
  assert.match(source, /expected\.length !== 24/);
  assert.match(source, /pngHash !== render\.sha256/);
  assert.match(source, /reviewHash !== render\.reviewSha256/);
  assert.match(source, /decision\.verdict/);
  assert.match(source, /current-review\.json/);
  assert.match(source, /Every persisted 1600x900 review image inspected individually at full size/);
});
