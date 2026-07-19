import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { portableProfileIntegrityHash } from "../plugins/slidewright/skills/slidewright/scripts/lib/design-profile.mjs";
import { groundPlanWithReference, validateDesignProvenance } from "../plugins/slidewright/skills/slidewright/scripts/lib/reference-grounding.mjs";

const universal = JSON.parse(await fs.readFile(path.resolve("fixtures/universal-design/deck-spec.json"), "utf8"));

function concept(sourceSlide, model) {
  const variant = {
    statement: "centered-color-field",
    "table-matrix": "banded-matrix",
    comparison: "split-highlight",
    "radial-diagram": "hub-spoke",
    "layered-diagram": "triangular-cycle",
    "process-flow": "chevron-steps",
    "column-cards": "parallel-cards",
    "structured-content": "stacked-content",
  }[model];
  const itemCount = model === "table-matrix" ? 4 : model === "comparison" ? 2 : model === "layered-diagram" ? 3 : model === "radial-diagram" ? 4 : 1;
  return {
    id: `concept-${sourceSlide}-${model}`,
    sourceSlide,
    slidePart: `ppt/slides/slide${sourceSlide}.xml`,
    sourceTitle: `${model} reference ${sourceSlide}`,
    communicationPurpose: `Use a ${model} composition for executive communication.`,
    composition: { model, variant, itemCount, hierarchy: "title-first", primaryFlow: "left-to-right", regions: [] },
    blueprint: {
      variant,
      itemCount,
      sourceObjectCount: 3,
      reconstructableWithNativeObjects: true,
      sourceObjects: [
        { objectKey: `slide-${sourceSlide}-surface`, kind: "sp", presetGeometry: "rect", normalized: { left: 0.1, top: 0.2, width: 0.8, height: 0.6 } },
      ],
    },
    objectTypes: { sp: 3 },
    spatialRelationships: { regionCount: 3, centralEmphasis: model === "radial-diagram", parallelStructure: true },
    density: { level: "medium", textCharacters: 300, substantiveObjects: 6 },
    emphasis: { pattern: model, titlePresent: true },
    suitability: { preferredContentTypes: [model], minimumItems: 1, maximumItems: 8, requiresMedia: false },
    nativeEditable: true,
    confidence: 0.95,
    tags: [model],
  };
}

function referenceProfile() {
  const models = ["statement", "statement", "table-matrix", "comparison", "comparison", "radial-diagram", "layered-diagram", "process-flow", "column-cards", "structured-content"];
  const concepts = models.map((model, index) => concept(index + 1, model));
  const profile = {
    schemaVersion: "slidewright-design-profile/v1",
    source: { fileName: "reference-library.pptx", sha256: "a".repeat(64) },
    profileSha256: "b".repeat(64),
    presentation: {
      guides: [{ order: 0, orientation: "vertical", positionEmu: 4000000, positionPt: 315 }],
      inheritanceChains: concepts.map((item, index) => ({
        slidePart: item.slidePart,
        layoutPart: `ppt/slideLayouts/slideLayout${index + 1}.xml`,
        masterPart: "ppt/slideMasters/slideMaster1.xml",
        themePart: index === 0 ? "ppt/theme/theme1.xml" : "ppt/theme/theme2.xml",
      })),
    },
    themes: [
      {
        part: "ppt/theme/theme1.xml", name: "Minority Theme", sha256: "1".repeat(64),
        colors: { lt1: { kind: "srgbClr", value: "FFFFFF" }, lt2: { kind: "srgbClr", value: "F5F5F5" }, dk1: { kind: "srgbClr", value: "111111" }, dk2: { kind: "srgbClr", value: "333333" }, accent1: { kind: "srgbClr", value: "FF0000" }, accent2: { kind: "srgbClr", value: "FFCCCC" }, accent3: { kind: "srgbClr", value: "777777" }, accent4: { kind: "srgbClr", value: "DDDDDD" }, accent6: { kind: "srgbClr", value: "008800" } },
        fonts: { majorFont: { latin: "Minority Display" }, minorFont: { latin: "Minority Text" } },
      },
      {
        part: "ppt/theme/theme2.xml", name: "Dominant Theme", sha256: "2".repeat(64),
        colors: { lt1: { kind: "srgbClr", value: "FAFAF8" }, lt2: { kind: "srgbClr", value: "FFFFFF" }, dk1: { kind: "srgbClr", value: "121212" }, dk2: { kind: "srgbClr", value: "454545" }, accent1: { kind: "srgbClr", value: "B71833" }, accent2: { kind: "srgbClr", value: "EB677D" }, accent3: { kind: "srgbClr", value: "93A1AD" }, accent4: { kind: "srgbClr", value: "DADADA" }, accent6: { kind: "srgbClr", value: "00AC41" } },
        fonts: { majorFont: { latin: "Reference Display" }, minorFont: { latin: "Arial" } },
      },
    ],
    masters: [{ part: "ppt/slideMasters/slideMaster1.xml", name: "Reference Master", sha256: "3".repeat(64), relationshipSha256: "4".repeat(64) }],
    layouts: concepts.map((item, index) => ({ part: `ppt/slideLayouts/slideLayout${index + 1}.xml`, name: `Layout ${index + 1}`, sha256: String((index + 1) % 10).repeat(64), relationshipSha256: String((index + 2) % 10).repeat(64) })),
    chrome: {
      objects: [
        { objectKey: "logo-1", part: "ppt/slideMasters/slideMaster1.xml", name: "Client Logo", type: "pic", geometry: { xEmu: 1 }, styleFingerprint: "5".repeat(64), xmlSha256: "6".repeat(64) },
        { objectKey: "footer-1", part: "ppt/slideMasters/slideMaster1.xml", name: "Footer", type: "sp", geometry: { xEmu: 2 }, styleFingerprint: "7".repeat(64), xmlSha256: "8".repeat(64) },
      ],
    },
    designConceptInventory: {
      schemaVersion: "slidewright-design-concept-inventory/v1",
      slidesTotal: concepts.length,
      viableSlides: concepts.length,
      nonviableSlides: 0,
      slideInventory: concepts.map((item) => ({ sourceSlide: item.sourceSlide, slidePart: item.slidePart, viable: true, reason: "test" })),
      concepts,
    },
  };
  profile.portableIntegritySha256 = portableProfileIntegrityHash(profile);
  return profile;
}

function profileWithConcepts(base, concepts) {
  const sourceSlides = new Set(concepts.map((item) => item.sourceSlide));
  const profile = {
    ...structuredClone(base),
    presentation: {
      ...structuredClone(base.presentation),
      inheritanceChains: base.presentation.inheritanceChains.filter((item) => sourceSlides.has(Number(item.slidePart.match(/slide(\d+)\.xml$/u)?.[1]))),
    },
    designConceptInventory: {
      ...structuredClone(base.designConceptInventory),
      slidesTotal: concepts.length,
      viableSlides: concepts.length,
      nonviableSlides: 0,
      slideInventory: concepts.map((item) => ({ sourceSlide: item.sourceSlide, slidePart: item.slidePart, viable: true, reason: "test" })),
      concepts: structuredClone(concepts),
    },
  };
  delete profile.portableIntegritySha256;
  profile.portableIntegritySha256 = portableProfileIntegrityHash(profile);
  return profile;
}

test("reference grounding maps every slide, uses six concepts, and produces independently valid provenance", () => {
  const baseline = compileDeck(universal);
  const profile = referenceProfile();
  const { plan, provenance } = groundPlanWithReference(baseline, profile);
  assert.equal(provenance.valid, true);
  assert.equal(provenance.generatedSlides, plan.slides.length);
  assert.equal(provenance.substantiveMappingRate, 1);
  assert.equal(provenance.genericFallbackSlides, 0);
  assert.ok(provenance.distinctReferenceConcepts >= 6);
  assert.ok(provenance.distinctCompositionModels.length >= 5);
  assert.ok(provenance.distinctCompositionVariants.length >= 5);
  assert.ok(plan.slides.every((slide) => slide.designProvenance?.referenceSlides?.length === 1));
  assert.equal(provenance.referenceTokens.sourceTheme.part, "ppt/theme/theme2.xml");
  assert.equal(provenance.referenceTokens.sourceTheme.inheritedSlides, profile.designConceptInventory.concepts.length - 1);
  assert.equal(provenance.referenceTokens.colors.accent.value, "#B71833");
  assert.equal(provenance.referenceTokens.fonts.major.value, "Reference Display");
  assert.equal(provenance.referenceTokens.fonts.minor.value, "Arial");
  assert.equal(provenance.tokenApplication.fontApplication.appliedFamily, "Arial");
  assert.equal(provenance.tokenApplication.fontApplication.appliedSourceRole, "minorFont.latin");
  assert.equal(provenance.tokenApplication.fontApplication.silentSubstitutionAllowed, false);
  assert.equal(plan.theme.fontFamily, "Arial");
  assert.equal(plan.theme.fallbackFontFamily, null);
  assert.equal(plan.theme.colors.accent, "#B71833");
  assert.equal(provenance.sourceStructure.guides.length, 1);
  assert.equal(provenance.sourceStructure.masters.length, 1);
  assert.equal(provenance.sourceStructure.layouts.length, profile.designConceptInventory.concepts.length);
  assert.equal(provenance.sourceStructure.logos[0].objectKey, "logo-1");
  assert.equal(provenance.sourceStructure.chrome.applicationStatus, "provenance-only");
  assert.ok(provenance.slides.filter((item) => item.status === "reference-derived").every((item) => item.nativeAdapter.supported && item.nativeAdapter.observableShapeIds.length));
  assert.equal(validateDesignProvenance(provenance, plan, profile).valid, true);
  const lint = lintPlan(plan);
  assert.equal(lint.valid, true, JSON.stringify(lint.diagnostics));
});

test("reference grounding resolves the standard Office sysClr default-theme tokens", () => {
  const profile = referenceProfile();
  const dominant = profile.themes.find((theme) => theme.part === "ppt/theme/theme2.xml");
  dominant.colors.lt1 = { kind: "sysClr", value: "FFFFFF", system: "window" };
  dominant.colors.dk1 = { kind: "sysClr", value: "BADBAD", lastClr: "000000", system: "windowText" };
  delete profile.portableIntegritySha256;
  profile.portableIntegritySha256 = portableProfileIntegrityHash(profile);

  const { plan, provenance } = groundPlanWithReference(compileDeck(universal), profile);
  assert.equal(provenance.referenceTokens.available, true);
  assert.equal(provenance.referenceTokens.sourceScheme.lt1.value, "#FFFFFF");
  assert.equal(provenance.referenceTokens.sourceScheme.dk1.value, "#000000");
  assert.equal(provenance.referenceTokens.colors.background.value, "#FFFFFF");
  assert.equal(provenance.referenceTokens.colors.text.value, "#000000");
  assert.equal(plan.theme.colors.background, "#FFFFFF");
  assert.equal(plan.theme.colors.text, "#000000");
  assert.equal(validateDesignProvenance(provenance, plan, profile).valid, true);
});

test("design provenance rejects source, mapping, and coverage mutations", () => {
  const profile = referenceProfile();
  const { plan, provenance } = groundPlanWithReference(compileDeck(universal), profile);
  for (const mutate of [
    (value) => { value.referenceDeckSha256 = "c".repeat(64); },
    (value) => { value.slides[0].referenceSlides = [999]; },
    (value) => { value.substantiveMappingRate = 0.5; },
    (value) => { value.genericFallbackSlides = 3; },
    (value) => { value.distinctReferenceConcepts = 1; },
    (value) => { value.mappedSubstantiveSlides -= 1; },
    (value) => { value.referenceTokens.colors.accent.value = "#000000"; },
    (value) => { value.sourceStructure.guides = []; },
    (value) => { value.slides[0].sourceItemCount += 1; },
    (value) => { value.slides[0].generatedItemCount += 1; },
  ]) {
    const mutant = structuredClone(provenance);
    mutate(mutant);
    assert.equal(validateDesignProvenance(mutant, plan, profile).valid, false);
  }
});

test("provenance binds substantive flags to the plan coverage role even when aggregate fields are forged", () => {
  const profile = referenceProfile();
  const baseline = compileDeck(universal);
  baseline.slides[0].coverageRole = "substantive";
  const { plan, provenance } = groundPlanWithReference(baseline, profile);
  const mutant = structuredClone(provenance);
  const index = mutant.slides.findIndex((mapping) => mapping.substantive);
  assert.ok(index >= 0);
  mutant.slides[index].substantive = false;
  const substantive = mutant.slides.filter((mapping) => mapping.substantive);
  const grounded = substantive.filter((mapping) => mapping.status === "reference-derived");
  mutant.substantiveGeneratedSlides = substantive.length;
  mutant.mappedSubstantiveSlides = grounded.length;
  mutant.substantiveMappingRate = substantive.length ? Number((grounded.length / substantive.length).toFixed(4)) : 1;

  const validation = validateDesignProvenance(mutant, plan, profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.includes(`slide-${index + 1}-substantive-binding`));
});

test("fallback mappings cannot inflate reference-derived concept, model, or variant diversity", () => {
  const profile = referenceProfile();
  const grounded = groundPlanWithReference(compileDeck(universal), profile);
  const plan = structuredClone(grounded.plan);
  const mutant = structuredClone(grounded.provenance);
  const mapping = mutant.slides[0];
  mapping.status = "generic-fallback";
  mapping.conceptId = "forged-fallback-concept";
  mapping.compositionModel = "forged-fallback-model";
  mapping.compositionVariant = "forged-fallback-variant";
  plan.slides[0].designProvenance.conceptId = mapping.conceptId;

  const substantive = mutant.slides.filter((item) => item.substantive);
  const groundedSubstantive = substantive.filter((item) => item.status === "reference-derived");
  mutant.mappedSubstantiveSlides = groundedSubstantive.length;
  mutant.substantiveMappingRate = substantive.length ? Number((groundedSubstantive.length / substantive.length).toFixed(4)) : 1;
  mutant.genericFallbackSlides = 1;
  // Forge the public aggregates using every mapping. A verifier must derive
  // these only from mappings that still carry reference-derived status.
  mutant.distinctReferenceConcepts = new Set(mutant.slides.map((item) => item.conceptId).filter(Boolean)).size;
  mutant.distinctCompositionModels = [...new Set(mutant.slides.map((item) => item.compositionModel).filter(Boolean))].sort();
  mutant.distinctCompositionVariants = [...new Set(mutant.slides.map((item) => item.compositionVariant).filter(Boolean))].sort();

  const validation = validateDesignProvenance(mutant, plan, profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.includes("aggregate-distinctReferenceConcepts"));
  assert.ok(validation.diagnostics.includes("aggregate-distinctCompositionModels"));
  assert.ok(validation.diagnostics.includes("aggregate-distinctCompositionVariants"));
});

test("topology-sensitive concepts cannot masquerade as a grounded match for the wrong number of semantic items", () => {
  const base = referenceProfile();
  const triangle = structuredClone(base.designConceptInventory.concepts.find((item) => item.composition.model === "layered-diagram"));
  triangle.suitability.minimumItems = 3;
  triangle.suitability.maximumItems = 3;
  const profile = {
    ...base,
    designConceptInventory: {
      ...base.designConceptInventory,
      slidesTotal: 1,
      viableSlides: 1,
      nonviableSlides: 0,
      slideInventory: [{ sourceSlide: triangle.sourceSlide, slidePart: triangle.slidePart, viable: true, reason: "test" }],
      concepts: [triangle],
    },
  };
  delete profile.portableIntegritySha256;
  profile.portableIntegritySha256 = portableProfileIntegrityHash(profile);
  const iconSlide = structuredClone(compileDeck(universal).slides.find((slide) => slide.layout === "icon-list"));
  iconSlide.coverageRole = "supporting";
  const { provenance } = groundPlanWithReference({ ...compileDeck(universal), slides: [iconSlide] }, profile);
  assert.equal(provenance.slides[0].generatedItemCount, 4);
  assert.equal(provenance.slides[0].sourceItemCount, 3);
  assert.equal(provenance.slides[0].status, "generic-fallback");
});

test("hub-spoke provenance requires an observable editable hub and explicit spokes", () => {
  const base = referenceProfile();
  const hub = base.designConceptInventory.concepts.find((item) => item.composition.variant === "hub-spoke");
  const profile = profileWithConcepts(base, [hub]);
  const iconSlide = structuredClone(compileDeck(universal).slides.find((slide) => slide.layout === "icon-list"));
  const { plan, provenance } = groundPlanWithReference({ ...compileDeck(universal), slides: [iconSlide] }, profile);
  const mapping = provenance.slides[0];
  assert.equal(mapping.status, "reference-derived");
  assert.equal(mapping.nativeAdapter.adapterId, "hub-spoke-v1");
  assert.ok(plan.slides[0].shapes.some((shape) => shape.id.endsWith("-reference-hub") && shape.geometry === "ellipse" && shape.editable));
  assert.equal(plan.slides[0].shapes.filter((shape) => /-reference-spoke-/u.test(shape.id) && shape.role === "reference-connector" && shape.editable).length, 4);
  const destructive = structuredClone(plan);
  destructive.slides[0].shapes = destructive.slides[0].shapes.filter((shape) => !shape.id.endsWith("-reference-hub"));
  assert.equal(validateDesignProvenance(provenance, destructive, profile).valid, false);
});

test("unsupported hub-spoke topology is an explicit fallback and never a false visual claim", () => {
  const base = referenceProfile();
  const hub = structuredClone(base.designConceptInventory.concepts.find((item) => item.composition.variant === "hub-spoke"));
  hub.suitability.minimumItems = 4;
  hub.suitability.maximumItems = 4;
  const profile = profileWithConcepts(base, [hub]);
  const comparison = structuredClone(compileDeck(universal).slides.find((slide) => slide.layout === "two-column"));
  comparison.coverageRole = "supporting";
  const { plan, provenance } = groundPlanWithReference({ ...compileDeck(universal), slides: [comparison] }, profile);
  assert.equal(provenance.slides[0].status, "generic-fallback");
  assert.equal(provenance.slides[0].nativeAdapter.supported, false);
  assert.equal(plan.slides[0].shapes.some((shape) => /-reference-(?:hub|spoke)-/u.test(shape.id)), false);
});

test("table reference grounding enforces the source semantic column topology", () => {
  const base = referenceProfile();
  const tableConcept = structuredClone(base.designConceptInventory.concepts.find((item) => item.composition.model === "table-matrix"));
  tableConcept.composition.variant = "option-matrix";
  tableConcept.blueprint.variant = "option-matrix";
  tableConcept.composition.itemCount = 3;
  tableConcept.blueprint.itemCount = 3;
  const profile = profileWithConcepts(base, [tableConcept]);
  const tableSlide = structuredClone(compileDeck(universal).slides.find((slide) => slide.layout === "table"));
  const columns = tableSlide.shapes.find((shape) => shape.type === "table").table.values[0].length;
  assert.notEqual(columns, tableConcept.composition.itemCount);
  tableSlide.coverageRole = "supporting";
  const { plan, provenance } = groundPlanWithReference({ ...compileDeck(universal), slides: [tableSlide] }, profile);
  assert.equal(provenance.slides[0].status, "generic-fallback");
  assert.equal(provenance.slides[0].generatedItemCount, columns);
  assert.equal(provenance.slides[0].sourceItemCount, 3);
  assert.equal(plan.slides[0].shapes.some((shape) => /reference-option-highlight/u.test(shape.id)), false);

  const unknownTopologyConcept = structuredClone(tableConcept);
  unknownTopologyConcept.composition.itemCount = 0;
  unknownTopologyConcept.blueprint.itemCount = 0;
  const unknownTopologyProfile = profileWithConcepts(base, [unknownTopologyConcept]);
  const unknownTopologyResult = groundPlanWithReference({ ...compileDeck(universal), slides: [tableSlide] }, unknownTopologyProfile);
  assert.equal(unknownTopologyResult.provenance.slides[0].status, "generic-fallback");
});

test("OOXML profiling normalizes standard gradients and inventories every viable slide without aborting", async (t) => {
  const source = path.resolve("fixtures/design-profile/mit-v1/slidewright-design-profile-source.pptx");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-gradient-profile-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const gradientDeck = path.join(temporary, "gradient.pptx");
  const profilePath = path.join(temporary, "profile.json");
  const asymmetryPath = path.join(temporary, "asymmetry.json");
  const python = process.env.SLIDEWRIGHT_PYTHON || "python";
  const mutation = String.raw`
import re,sys,zipfile
src,dst=sys.argv[1:3]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED) as zout:
 for info in zin.infolist():
  data=zin.read(info.filename)
  if info.filename=='ppt/slides/slide1.xml':
   text=data.decode('utf-8')
   gradient='<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"><a:alpha val="80000"/></a:srgbClr></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>'
   text,count=re.subn(r'<p:spPr\s*/>',f'<p:spPr>{gradient}</p:spPr>',text,count=1,flags=re.S)
   assert count==1
   data=text.encode('utf-8')
  zout.writestr(info,data)
`;
  const mutate = spawnSync(python, ["-c", mutation, source, gradientDeck], { encoding: "utf8" });
  assert.equal(mutate.status, 0, mutate.stderr);
  const asymmetryGenerator = path.resolve("fixtures/design-profile/mit-v1/generate-asymmetry-manifest.py");
  const asymmetry = spawnSync(python, [asymmetryGenerator, gradientDeck, asymmetryPath], { encoding: "utf8" });
  assert.equal(asymmetry.status, 0, asymmetry.stderr);
  const extractor = path.resolve("plugins/slidewright/skills/slidewright/scripts/design_profile/extract_design_profile.py");
  const extraction = spawnSync(python, [extractor, gradientDeck, "--asymmetry-manifest", asymmetryPath, "--out", profilePath, "--quiet"], { encoding: "utf8" });
  assert.equal(extraction.status, 0, extraction.stderr);
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const gradients = profile.objects.filter((item) => item.fill?.kind === "gradFill");
  assert.ok(gradients.length >= 1);
  assert.equal(gradients[0].fill.stops.length, 2);
  assert.equal(gradients[0].fill.stops[0].color.transforms[0].kind, "alpha");
  assert.equal(gradients[0].fill.mode.kind, "linear");
  assert.equal(profile.designConceptInventory.concepts.length, profile.designConceptInventory.viableSlides);
  assert.equal(profile.designConceptInventory.slideInventory.length, profile.slides.length);
  for (const item of profile.designConceptInventory.concepts) {
    assert.ok(item.communicationPurpose);
    assert.ok(item.composition.model);
    assert.ok(item.composition.variant);
    assert.ok(Number.isInteger(item.composition.itemCount));
    assert.ok(Array.isArray(item.composition.regions));
    assert.equal(item.blueprint.variant, item.composition.variant);
    assert.equal(item.blueprint.itemCount, item.composition.itemCount);
    assert.ok(Array.isArray(item.blueprint.sourceObjects));
    assert.equal(typeof item.blueprint.reconstructableWithNativeObjects, "boolean");
    assert.ok(item.sourceSlide >= 1);
    assert.ok(item.suitability.preferredContentTypes.length >= 1);
  }
});
