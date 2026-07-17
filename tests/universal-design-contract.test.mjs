import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { adaptDeckCopyToFit } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const demo = JSON.parse(fs.readFileSync(new URL("../examples/demo/deck-spec.json", import.meta.url), "utf8"));
const universal = JSON.parse(fs.readFileSync(new URL("../fixtures/universal-design/deck-spec.json", import.meta.url), "utf8"));

function diagnostics(plan, ruleId) {
  return lintPlan(plan).diagnostics.filter((item) => item.ruleId === ruleId);
}

function repeatedDeck() {
  const spec = structuredClone(demo);
  spec.version = "0.2";
  spec.slides.push({ ...structuredClone(spec.slides[1]), id: "difference-again" });
  return compileDeck(spec);
}

test("unrelated built-in archetypes share one logical design master without claiming a native PowerPoint master", () => {
  const plan = compileDeck({ ...structuredClone(demo), version: "0.2" });
  assert.equal(plan.schemaVersion, "0.2");
  assert.equal(plan.designSystem.schemaVersion, "slidewright-design-system/v1");
  assert.equal(plan.designSystem.logicalMaster.nativePowerPointMasterClaimed, false);
  assert.deepEqual(plan.designSystem.paragraphSpacingPt, [0, 6, 12]);
  assert.deepEqual(plan.designSystem.insetTokensPx, [0, 8, 12, 16, 24, 32]);
  assert.ok(plan.slides.every((slide) => slide.archetypeId && slide.designMasterId === plan.designSystem.logicalMaster.id));
  assert.equal(lintPlan(plan).valid, true);
});

test("multi-archetype fixture compiles native tables and semantically bound editable icons under one design contract", () => {
  const plan = compileDeck(structuredClone(universal));
  assert.equal(lintPlan(plan).valid, true);
  assert.deepEqual([...new Set(plan.slides.map((slide) => slide.archetypeId))], ["hero", "section", "two-column", "table", "icon-list", "continuation"]);
  const table = plan.slides.find((slide) => slide.layout === "table").shapes.find((shape) => shape.type === "table");
  assert.deepEqual(table.table.styles.header.insets, { top: 8, right: 8, bottom: 8, left: 8 });
  assert.equal(table.table.styles.header.fontSizePt, 16);
  const icons = plan.slides.find((slide) => slide.layout === "icon-list").shapes.filter((shape) => shape.semanticType === "icon");
  assert.equal(icons.length, 4);
  assert.ok(icons.every((icon) => icon.type === "text" && icon.editable && icon.semanticBinding.decorative === false));
});

test("guarded copy adaptation accepts every universal archetype without inventing table prose", () => {
  const result = adaptDeckCopyToFit(structuredClone(universal));
  assert.equal(result.spec.slides.length, universal.slides.length);
  assert.equal(result.spec.slides.find((slide) => slide.layout === "table").table.rows.length, 4);
  assert.equal(result.manifest.fields.some((field) => field.sourceSlideId === "universal-icons"), true);
  assert.equal(lintPlan(result.plan).valid, true);
});

test("icon-list copy stress relayouts one dense item without changing peer formatting", () => {
  const stressed = structuredClone(universal);
  stressed.slides.find((slide) => slide.layout === "icon-list").items[0].body = "The outcome and why it matters. ".repeat(45);
  const result = adaptDeckCopyToFit(stressed);
  assert.ok(result.spec.slides.length > stressed.slides.length);
  const sourceSlide = result.plan.slides.find((slide) => slide.id === "universal-icons");
  const bodySizes = sourceSlide.shapes.filter((shape) => shape.componentPattern?.slot === "body").map((shape) => shape.style.fontSizePt);
  assert.equal(new Set(bodySizes).size, 1);
  assert.ok(result.manifest.fields.find((field) => field.sourceSlideId === "universal-icons" && field.sourceField === "items.0.body").chunkCount > 1);
  assert.equal(lintPlan(result.plan).valid, true);
});

test("native table and icon mutants cannot bypass the deck-wide contract", () => {
  const tablePlan = compileDeck(structuredClone(universal));
  const table = tablePlan.slides.find((slide) => slide.layout === "table").shapes.find((shape) => shape.type === "table");
  table.table.styles.body.insets.right = 12;
  assert.equal(diagnostics(tablePlan, "SW023").length, 1);

  const overflowPlan = compileDeck(structuredClone(universal));
  overflowPlan.slides.find((slide) => slide.layout === "table").shapes.find((shape) => shape.type === "table").table.values[1][0] = "W ".repeat(200);
  assert.equal(diagnostics(overflowPlan, "SW004").length, 1);

  const iconPlan = compileDeck(structuredClone(universal));
  const icon = iconPlan.slides.find((slide) => slide.layout === "icon-list").shapes.find((shape) => shape.semanticType === "icon");
  icon.icon.name = "globe";
  assert.equal(diagnostics(iconPlan, "SW026").length, 1);
});

test("required component, icon, backing, and spacing contracts cannot be removed or widened", () => {
  const componentPlan = compileDeck(structuredClone(universal));
  const component = componentPlan.slides.find((slide) => slide.layout === "two-column").shapes.find((shape) => shape.componentPattern?.slot === "heading");
  delete component.componentPattern;
  component.style.color = "#FF0000";
  assert.ok(diagnostics(componentPlan, "SW025").length >= 1);

  const decorativePlan = compileDeck(structuredClone(universal));
  const icon = decorativePlan.slides.find((slide) => slide.layout === "icon-list").shapes.find((shape) => shape.semanticType === "icon");
  icon.icon.name = "nonsense";
  icon.semanticBinding = { decorative: true };
  assert.equal(diagnostics(decorativePlan, "SW026").length, 1);

  const backingPlan = compileDeck(structuredClone(universal));
  backingPlan.slides[0].layoutContract.backings = [];
  assert.ok(diagnostics(backingPlan, "SW024").length >= 1);

  const spacingPlan = compileDeck(structuredClone(universal));
  spacingPlan.designSystem.paragraphSpacingPt.push(8);
  spacingPlan.slides[0].shapes.find((shape) => shape.id === "s1-body").text.paragraphs[0].spaceAfterPt = 8;
  assert.ok(diagnostics(spacingPlan, "SW029").length >= 1);

  const archetypeBackingPlan = compileDeck(structuredClone(universal));
  delete archetypeBackingPlan.designSystem.archetypes.hero.requiredBackedRoles;
  const hero = archetypeBackingPlan.slides[0];
  hero.layoutContract.backings = [];
  hero.shapes = hero.shapes.filter((shape) => shape.id !== "s1-callout-surface");
  const callout = hero.shapes.find((shape) => shape.id === "s1-callout");
  delete callout.backingId;
  delete callout.parentId;
  assert.ok(diagnostics(archetypeBackingPlan, "SW029").length >= 1);
  assert.ok(diagnostics(archetypeBackingPlan, "SW024").length >= 1);

  const archetypeComponentPlan = compileDeck(structuredClone(universal));
  delete archetypeComponentPlan.designSystem.archetypes["two-column"].componentFamilies;
  const repeated = archetypeComponentPlan.slides.find((slide) => slide.layout === "two-column").shapes.find((shape) => shape.componentPattern?.slot === "heading");
  delete repeated.componentPattern;
  repeated.style.color = "#FF0000";
  assert.ok(diagnostics(archetypeComponentPlan, "SW029").length >= 1);
  assert.ok(diagnostics(archetypeComponentPlan, "SW025").length >= 1);

  const archetypeIconPlan = compileDeck(structuredClone(universal));
  archetypeIconPlan.designSystem.archetypes["icon-list"].requiresSemanticIcons = false;
  const requiredIcon = archetypeIconPlan.slides.find((slide) => slide.layout === "icon-list").shapes.find((shape) => shape.semanticType === "icon");
  requiredIcon.icon.name = "nonsense";
  requiredIcon.semanticBinding.decorative = true;
  assert.ok(diagnostics(archetypeIconPlan, "SW029").length >= 1);
  assert.ok(diagnostics(archetypeIconPlan, "SW026").length >= 1);

  const typographyPlan = compileDeck(structuredClone(universal));
  typographyPlan.designSystem.typographyRoles["hero-title"].minimumSizePt = 12;
  const title = typographyPlan.slides[0].shapes.find((shape) => shape.id === "s1-title");
  title.fit.minSizePt = 12;
  title.style.fontSizePt = 12;
  title.headlinePolicy.maximumAutoSizeSteps = 20;
  assert.ok(diagnostics(typographyPlan, "SW029").length >= 1);
  assert.ok(diagnostics(typographyPlan, "SW027").length >= 1);

  const injectedArchetypePlan = compileDeck(structuredClone(universal));
  injectedArchetypePlan.designSystem.archetypes.custom = { pageRole: "custom", requiredStyleRoles: [] };
  const rebound = injectedArchetypePlan.slides.find((slide) => slide.layout === "two-column");
  rebound.archetypeId = "custom";
  rebound.pageRole = "custom";
  for (const shape of rebound.shapes) delete shape.componentPattern;
  assert.ok(diagnostics(injectedArchetypePlan, "SW029").length >= 1);

  const injectedRolePlan = compileDeck(structuredClone(universal));
  injectedRolePlan.designSystem.typographyRoles.custom = { preferredSizePt: 14, minimumSizePt: 12, maximumLines: 8, lineHeight: 1, baseWeight: "regular" };
  const reboundTitle = injectedRolePlan.slides[0].shapes.find((shape) => shape.id === "s1-title");
  reboundTitle.typographyRole = "custom";
  reboundTitle.styleTokenRefs.typography = "custom";
  reboundTitle.style.fontSizePt = 12;
  reboundTitle.fit.preferredSizePt = 14;
  reboundTitle.fit.minSizePt = 12;
  reboundTitle.headlinePolicy.typographyRole = "custom";
  assert.ok(diagnostics(injectedRolePlan, "SW029").length >= 1);
});

test("paragraph-aware compilation uses native 6pt rhythm between body paragraphs and includes it in fitting", () => {
  const spec = { ...structuredClone(demo), version: "0.2" };
  spec.slides[0].body = {
    paragraphs: [
      { runs: [{ text: "First reusable body paragraph.", bold: false }] },
      { runs: [{ text: "Second reusable body paragraph.", bold: false }] },
      { runs: [{ text: "Third reusable body paragraph.", bold: false }] },
    ],
  };
  const plan = compileDeck(spec);
  const body = plan.slides[0].shapes.find((shape) => shape.id === "s1-body");
  assert.deepEqual(body.text.paragraphs.map((paragraph) => [paragraph.spaceBeforePt, paragraph.spaceAfterPt]), [[0, 6], [0, 6], [0, 0]]);
  assert.equal(lintPlan(plan).valid, true);
});

test("SW023 rejects random asymmetric text and table-cell insets", () => {
  const textPlan = compileDeck(structuredClone(demo));
  textPlan.slides[0].shapes.find((shape) => shape.id === "s1-title").style.insets.bottom = 12;
  assert.equal(diagnostics(textPlan, "SW023").length, 1);

  const tablePlan = compileDeck(structuredClone(demo));
  tablePlan.slides[0].shapes.find((shape) => shape.id === "s1-callout-surface").table = {
    cells: [{ insets: { top: 8, right: 8, bottom: 24, left: 8 } }],
  };
  assert.equal(diagnostics(tablePlan, "SW023").length, 1);
});

test("SW024 rejects text escaping a declared covering block by one pixel", () => {
  const plan = compileDeck(structuredClone(demo));
  plan.slides[0].shapes.find((shape) => shape.id === "s1-callout").position.width += 1;
  assert.equal(diagnostics(plan, "SW024").length, 1);
});

test("SW025 rejects one inconsistent repeated heading while preserving declared archetype variants", () => {
  const plan = repeatedDeck();
  const repeated = plan.slides.find((slide) => slide.id === "difference-again");
  const heading = repeated.shapes.find((shape) => shape.componentPattern?.slot === "heading" && shape.componentPattern.variantId === "neutral");
  heading.style.fontSizePt = 18;
  assert.equal(diagnostics(plan, "SW025").length, 1);
});

test("SW026 binds an icon to a declared concept and rejects a semantically unrelated icon", () => {
  const plan = compileDeck(structuredClone(demo));
  plan.designSystem.iconOntology.goal = { icons: ["target", "bullseye"] };
  const label = plan.slides[0].shapes.find((shape) => shape.id === "s1-eyebrow");
  label.semanticConceptId = "goal";
  plan.slides[0].shapes.push({
    id: "goal-icon",
    type: "shape",
    role: "icon",
    semanticType: "icon",
    icon: { name: "globe" },
    semanticBinding: { conceptId: "goal", labelId: label.id, decorative: false },
    geometry: "ellipse",
    position: { left: 1220, top: 680, width: 16, height: 16 },
    fill: "#4F46E5",
    line: { color: "#4F46E5", width: 0 },
    editable: true,
  });
  assert.equal(diagnostics(plan, "SW026").length, 1);
  plan.slides[0].shapes.at(-1).icon.name = "target";
  assert.equal(diagnostics(plan, "SW026").length, 0);
});

test("SW027 rejects a constrained headline that relies on aggressive shrinking", () => {
  const plan = compileDeck(structuredClone(demo));
  const title = plan.slides[0].shapes.find((shape) => shape.id === "s1-title");
  title.style.fontSizePt = 40;
  assert.equal(diagnostics(plan, "SW027").length, 1);
});

test("SW028 rejects arbitrary or stacked paragraph spacing", () => {
  const spec = structuredClone(demo);
  spec.slides[0].body = { paragraphs: [
    { runs: [{ text: "First", bold: false }] },
    { runs: [{ text: "Second", bold: false }] },
  ] };
  const arbitrary = compileDeck(spec);
  arbitrary.slides[0].shapes.find((shape) => shape.id === "s1-body").text.paragraphs[0].spaceAfterPt = 8;
  assert.equal(diagnostics(arbitrary, "SW028").length, 1);

  const stacked = compileDeck(spec);
  const paragraphs = stacked.slides[0].shapes.find((shape) => shape.id === "s1-body").text.paragraphs;
  paragraphs[0].spaceAfterPt = 6;
  paragraphs[1].spaceBeforePt = 6;
  assert.equal(diagnostics(stacked, "SW028").length, 1);
});

test("SW029 rejects missing design systems, unknown archetypes, and undeclared slide exceptions", () => {
  const missing = compileDeck(structuredClone(demo));
  delete missing.designSystem;
  assert.ok(diagnostics(missing, "SW029").length > 0);

  const unknown = compileDeck(structuredClone(demo));
  unknown.slides[0].archetypeId = "random-one-off-layout";
  assert.ok(diagnostics(unknown, "SW029").length > 0);

  const waiver = compileDeck(structuredClone(demo));
  waiver.slides[0].typedExceptions.push({ ruleId: "SW024", reason: "make it fit somehow" });
  assert.ok(diagnostics(waiver, "SW029").length > 0);
});
