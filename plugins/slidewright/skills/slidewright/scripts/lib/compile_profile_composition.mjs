import { selectDesignArchetype, validateDesignProfile } from "./design-profile.mjs";
import { compileProfileDerivation } from "./compile_profile_derivation.mjs";

function fail(message) {
  throw new Error("Invalid profile composition: " + message);
}

function selectContentArchetype(profile, content, label) {
  if (!content || typeof content !== "object" || Array.isArray(content)) fail(label + " must be an object.");
  const selector = content.targetSlide
    ? { id: profile.archetypes.find((item) => item.sourceSlide === content.targetSlide)?.id }
    : { layoutName: content.archetype };
  return selectDesignArchetype(profile, selector);
}

function compileSlide(profile, content, label) {
  const archetype = selectContentArchetype(profile, content, label);
  if (!Array.isArray(content.replacements) || content.replacements.length === 0) fail(label + ".replacements must be non-empty.");
  const byShape = new Map(archetype.placeholders.map((placeholder) => [placeholder.shapeName, placeholder]));
  const edits = content.replacements.map((replacement, index) => {
    if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) fail(`${label}.replacements[${index}] must be an object.`);
    const placeholder = byShape.get(replacement.shapeName);
    if (!placeholder) fail(`${label}.replacements[${index}] targets undeclared shape '${replacement.shapeName}'.`);
    if (replacement.before !== placeholder.sourceText) fail(`${label} source text mismatch for '${replacement.shapeName}'.`);
    return { placeholderId: placeholder.id, after: replacement.after };
  });
  return compileProfileDerivation(profile, { archetype: { id: archetype.id }, edits });
}

function validateSourceRights(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("sourceRights must be an object for g22-v2 composition.");
  if (!["licensed", "user-provided-authorized"].includes(value.basis)) fail("sourceRights.basis must be licensed or user-provided-authorized.");
  if (typeof value.redistributionAllowed !== "boolean") fail("sourceRights.redistributionAllowed must be boolean.");
  if (value.basis === "licensed" && (typeof value.license !== "string" || !value.license.trim())) fail("licensed composition requires sourceRights.license.");
  if (value.basis === "user-provided-authorized" && (typeof value.attestation !== "string" || !value.attestation.trim())) fail("user-provided composition requires a concise sourceRights.attestation.");
  return {
    basis: value.basis,
    redistributionAllowed: value.redistributionAllowed,
    ...(value.license ? { license: value.license } : {}),
    ...(value.attestation ? { attestation: value.attestation } : {}),
    sourceBytesPolicy: value.redistributionAllowed ? "license-governed" : "local-only-do-not-publish",
  };
}

export function compileProfileComposition(profileInput, contentSpec) {
  const profile = validateDesignProfile(profileInput);
  if (!contentSpec || typeof contentSpec !== "object" || Array.isArray(contentSpec)) fail("content spec must be an object.");
  if (contentSpec.mode !== "compose-source-archetypes") fail("g22-v2 content spec mode must be compose-source-archetypes.");
  if (!Array.isArray(contentSpec.slides) || contentSpec.slides.length < 2) fail("g22-v2 composition requires at least two output slides.");
  const sourceRights = validateSourceRights(contentSpec.sourceRights);
  const slides = contentSpec.slides.map((item, index) => {
    const compiled = compileSlide(profile, item, `content spec slides[${index}]`);
    return {
      outputSlide: index + 1,
      sourceSlide: compiled.targetSlide,
      sourceSlidePart: compiled.designBinding.sourceSlideId,
      archetypeId: compiled.designBinding.archetypeId,
      edits: compiled.edits,
      designBinding: compiled.designBinding,
    };
  });
  return {
    version: "0.2",
    derivationVersion: "g22-v2",
    mode: "compose-source-archetypes",
    source: profile.source.fileName,
    sourceSha256: profile.source.sha256.toLowerCase(),
    sourceSlideCount: profile.source.slideCount,
    outputSlideCount: slides.length,
    sourceRights,
    slides,
    packagePolicy: {
      cloneSelectedNativeSlides: true,
      preserveSourceMasterLayoutTheme: true,
      preservePresentationGuides: true,
      garbageCollectUnreachableParts: true,
      rebaseDuplicatedCreationIds: true,
      preserveUndeclaredObjects: true,
      allowArbitraryImport: false,
    },
    allowedDeviation: [
      "new presentation slide order and slide relationship inventory",
      "declared native placeholder text replacements",
      "deterministic duplicate-slide creation-id and slide-number cache rebasing",
      "removal of source parts unreachable from the new presentation relationship graph",
    ],
  };
}
