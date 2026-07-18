import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  adaptExtractedProfile,
  portableProfileIntegrityHash,
  contractToRimPair,
  loadDesignProfile,
  selectDesignArchetype,
  validateDesignProfile,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/design-profile.mjs";
import {
  compileProfileContentSpec,
  compileProfileDerivation,
  loadAndCompileProfileDerivation,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/compile_profile_derivation.mjs";

const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const designProfilePython = path.resolve("plugins/slidewright/skills/slidewright/scripts/design_profile");

function profileFixture() {
  return {
    version: "g22-v1",
    id: "mit-source-profile",
    source: {
      kind: "native-pptx",
      fileName: "slidewright-design-profile-source.pptx",
      sha256: "a".repeat(64),
      slideCount: 3,
      canvas: { widthEmu: 12192000, heightEmu: 6858000, orientation: "landscape" },
    },
    reusePolicy: {
      mode: "clone-source-deck",
      preserveUndeclaredObjects: true,
      allowArbitraryImport: false,
    },
    theme: {
      fonts: { major: "Aptos Display", minor: "Aptos", families: ["Aptos Display", "Aptos"] },
      colors: { background: "#f4f7f8", text: "#33252B", accent: "#F26552" },
      commonFontSizesPt: [36, 24, 18, 14],
    },
    guides: { verticalPt: [120, 840], horizontalPt: [72, 468] },
    logos: [{
      id: "footer-logo",
      shapeName: "Brand logo",
      sha256: "b".repeat(64),
      slideNumbers: [1, 2, 3],
    }],
    archetypes: [
      {
        id: "title-and-body",
        sourceSlide: 1,
        sourceSlideId: "slide-1",
        layoutName: "Title and Content",
        masterName: "MIT Master",
        orientation: "landscape",
        tags: ["review", "content"],
        placeholders: [
          {
            id: "title",
            shapeName: "MIT Fixture Title",
            placeholderType: "title",
            placeholderIndex: 0,
            sourceText: "Quarterly operating review",
            sourceObjectKey: "ppt/slides/slide1.xml::/0/0/2::MIT Fixture Title",
            sourceObjectSha256: "c".repeat(64),
            sourceShapeId: "2",
            sourceCreationId: "{00000000-0000-0000-0000-000000000002}",
            sourceParagraphSha256s: ["d".repeat(64)],
            allowedEdits: ["text"],
            required: true,
            maxCharacters: 40,
            maxLines: 1,
          },
          {
            id: "body",
            shapeName: "MIT Fixture Body",
            placeholderType: "body",
            placeholderIndex: 1,
            sourceText: "Three priorities\nOne accountable owner\nA decision by Friday",
            sourceObjectKey: "ppt/slides/slide1.xml::/0/0/3::MIT Fixture Body",
            sourceObjectSha256: "e".repeat(64),
            sourceShapeId: "3",
            sourceCreationId: "{00000000-0000-0000-0000-000000000003}",
            sourceParagraphSha256s: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
            allowedEdits: ["text"],
            maxCharacters: 100,
            maxLines: 3,
          },
        ],
        chrome: {
          preservedShapeNames: ["Brand logo", "Footer", "Left limit", "Right limit"],
          rimPairs: [{
            id: "side-limits",
            role: "limiting",
            symmetryPolicy: "equal",
            members: [
              { side: "left", shapeName: "Left limit", widthPt: 1.5, insetPt: 24, color: "#F26552", dash: "solid" },
              { side: "right", shapeName: "Right limit", widthPt: 1.5, insetPt: 24, color: "#F26552", dash: "solid" },
            ],
          }],
        },
      },
      {
        id: "control",
        sourceSlide: 2,
        sourceSlideId: "slide-2",
        orientation: "landscape",
        tags: ["control"],
        placeholders: [{
          id: "control-body",
          shapeName: "Control body",
          placeholderType: "body",
          placeholderIndex: 1,
          sourceText: "Preserve me",
          sourceObjectKey: "ppt/slides/slide2.xml::/0/0/2::Control body",
          sourceObjectSha256: "4".repeat(64),
          sourceShapeId: "2",
          sourceCreationId: "",
          sourceParagraphSha256s: ["5".repeat(64)],
          allowedEdits: ["text"],
        }],
        chrome: { preservedShapeNames: ["Brand logo"], rimPairs: [] },
      },
    ],
  };
}

test("captures standard DrawingML color transforms losslessly and rejects unknown transforms", () => {
  const script = `
import json, sys
from xml.etree import ElementTree as ET
sys.path.insert(0, ${JSON.stringify(designProfilePython)})
from design_profile_core import ProfileError, color
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
value = ET.fromstring(f'<a:srgbClr xmlns:a="{A}" val="336699"><a:alpha val="50000"/><a:lumMod val="75000"/></a:srgbClr>')
captured = color(value, "fixture")
unknown_rejected = False
try:
    color(ET.fromstring(f'<a:srgbClr xmlns:a="{A}" val="336699"><a:invented val="1"/></a:srgbClr>'), "fixture")
except ProfileError:
    unknown_rejected = True
print(json.dumps({"captured": captured, "unknownRejected": unknown_rejected}, sort_keys=True))
`;
  const result = spawnSync(python, ["-c", script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.captured, {
    kind: "srgbClr",
    value: "336699",
    transforms: [
      { kind: "alpha", attributes: { val: "50000" } },
      { kind: "lumMod", attributes: { val: "75000" } },
    ],
  });
  assert.equal(report.unknownRejected, true);
});

test("validates and loads a clone-only source-bound profile", async (t) => {
  const source = profileFixture();
  const validated = validateDesignProfile(source);
  assert.notEqual(validated, source);
  assert.equal(validated.theme.colors.background, "#F4F7F8");

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-profile-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(source), "utf8");
  assert.equal((await loadDesignProfile(profilePath)).id, "mit-source-profile");
});

test("rejects arbitrary-import claims and malformed source bindings", () => {
  const arbitrary = profileFixture();
  arbitrary.reusePolicy.allowArbitraryImport = true;
  assert.throws(() => validateDesignProfile(arbitrary), /allowArbitraryImport must be false/u);

  const digest = profileFixture();
  digest.source.sha256 = "not-a-digest";
  assert.throws(() => validateDesignProfile(digest), /SHA-256 digest/u);
});

test("enforces equal widths and paired geometry for symmetric rim lines", () => {
  const widthDrift = profileFixture();
  widthDrift.archetypes[0].chrome.rimPairs[0].members[1].widthPt = 2;
  assert.throws(() => validateDesignProfile(widthDrift), /same widthPt/u);

  const insetDrift = profileFixture();
  insetDrift.archetypes[0].chrome.rimPairs[0].members[1].insetPt = 25;
  assert.throws(() => validateDesignProfile(insetDrift), /same insetPt/u);

  const explicit = profileFixture();
  const pair = explicit.archetypes[0].chrome.rimPairs[0];
  pair.symmetryPolicy = "preserve-source-asymmetry";
  pair.sourceAsymmetryReason = "The licensed source uses a deliberate asymmetric edge hierarchy.";
  pair.members[1].widthPt = 2;
  assert.equal(validateDesignProfile(explicit).archetypes[0].chrome.rimPairs[0].members[1].widthPt, 2);
});

test("adapts declared paired rules as divider contracts with exact EMU evidence", () => {
  const pair = contractToRimPair({
    part: "ppt/slideLayouts/slideLayout3.xml",
    orientation: "vertical",
    first: "SW Declared Rule Left",
    second: "SW Declared Rule Right",
    thicknessEmu: [38100, 63500],
    oppositeEdgeOffsetsEmu: [2336800, 2336800],
    equalAppearance: true,
    symmetric: false,
    appearance: [
      { fill: { color: { value: "E36B3D" } }, line: { dash: "solid" } },
      { fill: { color: { value: "E36B3D" } }, line: { dash: "solid" } },
    ],
    declaredAsymmetry: {
      reason: "Source-authored paired section rules use different thickness.",
      sourceSha256: "a".repeat(64),
      sourceObjectSha256: {
        "SW Declared Rule Left": "b".repeat(64),
        "SW Declared Rule Right": "c".repeat(64),
      },
    },
  });

  assert.equal(pair.role, "divider");
  assert.equal(pair.symmetryPolicy, "preserve-source-asymmetry");
  assert.deepEqual(pair.sourceContract.thicknessEmu, [38100, 63500]);
  assert.equal(pair.sourceContract.symmetric, false);

  const profile = profileFixture();
  profile.archetypes[0].chrome.rimPairs.push(pair);
  assert.equal(validateDesignProfile(profile).archetypes[0].chrome.rimPairs[1].role, "divider");
  profile.archetypes[0].chrome.rimPairs[1].sourceContract.symmetric = true;
  assert.throws(() => validateDesignProfile(profile), /conflicts with exact EMU\/appearance/u);
});

test("archetype selection is explicit and rejects ambiguity", () => {
  const profile = profileFixture();
  assert.equal(selectDesignArchetype(profile, { id: "title-and-body" }).sourceSlide, 1);
  assert.equal(selectDesignArchetype(profile, { tags: ["control"] }).id, "control");
  assert.throws(() => selectDesignArchetype(profile), /ambiguous/u);
  assert.throws(() => selectDesignArchetype(profile, { id: "missing" }), /No design archetype/u);
});

test("compiles only declared placeholder text edits into a source-bound clone plan", () => {
  const source = profileFixture();
  const sourceSnapshot = structuredClone(source);
  const plan = compileProfileDerivation(source, {
    archetype: { id: "title-and-body" },
    edits: {
      title: "Annual operating review",
      body: "Four priorities\nOne accountable owner\nA decision by Thursday",
    },
  });

  assert.equal(plan.mode, "clone-source-deck");
  assert.equal(plan.sourceSha256, "a".repeat(64));
  assert.equal(plan.targetSlide, 1);
  assert.deepEqual(plan.preserveOnlySlides, [2, 3]);
  assert.deepEqual(plan.edits.map((edit) => edit.shapeName), ["MIT Fixture Title", "MIT Fixture Body"]);
  assert.equal(plan.designBinding.preserveUndeclaredObjects, true);
  assert.equal(plan.designBinding.allowArbitraryImport, false);
  assert.deepEqual(plan.designBinding.guides, { verticalPt: [120, 840], horizontalPt: [72, 468] });
  assert.equal(plan.designBinding.rimPairs[0].members[0].widthPt, plan.designBinding.rimPairs[0].members[1].widthPt);
  assert.deepEqual(source, sourceSnapshot);
});

test("rejects undeclared, duplicate, no-op, and overflowing placeholder edits", () => {
  const profile = profileFixture();
  const request = (edits) => ({ archetype: { id: "title-and-body" }, edits });
  assert.throws(() => compileProfileDerivation(profile, request({ unknown: "Text" })), /undeclared placeholder/u);
  assert.throws(() => compileProfileDerivation(profile, request([
    { placeholderId: "title", after: "One" },
    { placeholderId: "title", after: "Two" },
  ])), /more than once/u);
  assert.throws(() => compileProfileDerivation(profile, request({ title: "Quarterly operating review" })), /no-op/u);
  assert.throws(() => compileProfileDerivation(profile, request({ title: "x".repeat(41) })), /maxCharacters 40/u);
  assert.throws(() => compileProfileDerivation(profile, request({ body: "one\ntwo\nthree\nfour" })), /maxLines 3/u);
});

test("compiles a source-bound native-run insertion for an empty template placeholder", () => {
  const profile = profileFixture();
  const title = profile.archetypes[0].placeholders[0];
  title.sourceText = "";
  const plan = compileProfileDerivation(profile, {
    archetype: { id: "title-and-body" },
    edits: { title: "New presentation title" },
  });
  assert.equal(plan.edits[0].editMode, "populate-empty-placeholder");
  assert.equal(plan.edits[0].before, "");
  assert.equal(plan.edits[0].after, "New presentation title");
  assert.throws(
    () => compileProfileDerivation(profile, {
      archetype: { id: "title-and-body" },
      edits: { title: "Line one\nLine two" },
    }),
    /currently accepts exactly one line/u,
  );
});

test("loads and compiles a profile without broadening reuse claims", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-profile-compile-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profileFixture()), "utf8");

  const plan = await loadAndCompileProfileDerivation(profilePath, {
    archetype: { id: "title-and-body" },
    edits: { title: "Annual operating review" },
  });

  assert.equal(plan.derivationVersion, "g22-v1");
  assert.equal(plan.designBinding.layoutName, "Title and Content");
  assert.deepEqual(plan.designBinding.logoIds, ["footer-logo"]);
  assert.deepEqual(plan.edits, [{
    shapeName: "MIT Fixture Title",
    placeholderType: "title",
    placeholderIndex: 0,
    before: "Quarterly operating review",
    after: "Annual operating review",
    sourceObjectKey: "ppt/slides/slide1.xml::/0/0/2::MIT Fixture Title",
    sourceObjectSha256: "c".repeat(64),
    sourceShapeId: "2",
    sourceCreationId: "{00000000-0000-0000-0000-000000000002}",
    sourceParagraphSha256s: ["d".repeat(64)],
  }]);
});
test("maps exact shape-bound content specs into the clone-only plan", () => {
  const plan = compileProfileContentSpec(profileFixture(), {
    targetSlide: 1,
    replacements: [
      {
        shapeName: "MIT Fixture Title",
        before: "Quarterly operating review",
        after: "Annual operating review",
      },
    ],
  });

  assert.equal(plan.mode, "clone-source-deck");
  assert.equal(plan.targetSlide, 1);
  assert.equal(plan.edits[0].shapeName, "MIT Fixture Title");
  assert.equal(plan.edits[0].after, "Annual operating review");
  assert.throws(
    () => compileProfileContentSpec(profileFixture(), {
      targetSlide: 1,
      replacements: [{
        shapeName: "MIT Fixture Title",
        before: "Stale source text",
        after: "Annual operating review",
      }],
    }),
    /source text mismatch/u,
  );
});


test("rejects tampered extracted profiles and maps only explicit logo groups", () => {
  const raw = {
    schemaVersion: "slidewright-design-profile/v1",
    profileSha256: "c".repeat(64),
    source: { sha256: "d".repeat(64) },
    presentation: {
      slideSize: { widthEmu: 12192000, heightEmu: 6858000 },
      guides: [],
    },
    themes: [{
      fonts: {
        majorFont: { latin: "Arial", ea: "", cs: "" },
        minorFont: { latin: "Arial", ea: "", cs: "" },
      },
      colors: { accent1: { kind: "srgbClr", value: "3D53E5" } },
    }],
    masters: [{ part: "ppt/slideMasters/slideMaster1.xml", name: "Master" }],
    layouts: [{ part: "ppt/slideLayouts/slideLayout1.xml", name: "Content" }],
    slides: [{
      part: "ppt/slides/slide1.xml",
      layoutPart: "ppt/slideLayouts/slideLayout1.xml",
    }],
    objects: [{
      part: "ppt/slides/slide1.xml",
      name: "Title",
      objectKey: "ppt/slides/slide1.xml::/0/0/2::Title",
      xmlSha256: "1".repeat(64),
      id: "2",
      creationId: "",
      placeholder: { type: "title", index: 0 },
      text: { plainText: "Source title", paragraphs: [{ xmlSha256: "2".repeat(64) }] },
    }],
    assets: {
      logos: [{ name: "SW Logo Group" }],
      groups: [
        { name: "SW Logo Group", xmlSha256: "e".repeat(64) },
        { name: "Chart Group", xmlSha256: "f".repeat(64) },
      ],
    },
    chrome: { objects: [] },
    symmetryContracts: [],
  };
  raw.portableIntegritySha256 = portableProfileIntegrityHash(raw);
  const intent = {
    source: "source.pptx",
    expected: {
      editablePlaceholders: ["Title"],
      integerFontSizes: [12, 18, 30],
      logoGroup: "SW Logo Group",
    },
  };

  const profile = adaptExtractedProfile(raw, intent);
  assert.deepEqual(profile.logos.map((logo) => logo.shapeName), ["SW Logo Group"]);

  const tampered = structuredClone(raw);
  tampered.presentation.slideSize.widthEmu += 1;
  assert.throws(() => adaptExtractedProfile(tampered, intent), /integrity check failed/u);
});
