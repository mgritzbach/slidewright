import { loadDesignProfile, selectDesignArchetype, validateDesignProfile } from "./design-profile.mjs";

function fail(message) {
  throw new Error("Invalid profile derivation: " + message);
}

function normalizeRequestedEdits(edits) {
  if (Array.isArray(edits)) return edits;
  if (edits && typeof edits === "object") {
    return Object.entries(edits).map(([placeholderId, after]) => ({ placeholderId, after }));
  }
  fail("edits must be a non-empty array or placeholder-id map.");
}

function compileEdits(archetype, requestedEdits) {
  const edits = normalizeRequestedEdits(requestedEdits);
  if (edits.length === 0) fail("edits must be non-empty.");
  const placeholders = new Map(archetype.placeholders.map((placeholder) => [placeholder.id, placeholder]));
  const seen = new Set();

  return edits.map((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) fail("edits[" + index + "] must be an object.");
    if (typeof request.placeholderId !== "string" || !placeholders.has(request.placeholderId)) {
      fail("edits[" + index + "] references undeclared placeholder '" + request?.placeholderId + "'.");
    }
    if (seen.has(request.placeholderId)) fail("placeholder '" + request.placeholderId + "' is edited more than once.");
    seen.add(request.placeholderId);

    const placeholder = placeholders.get(request.placeholderId);
    if (!placeholder.allowedEdits.includes("text")) fail("placeholder '" + placeholder.id + "' does not allow text edits.");
    if (typeof request.after !== "string" || request.after.length === 0) fail("placeholder '" + placeholder.id + "' requires non-empty replacement text.");
    if (request.after === placeholder.sourceText) fail("placeholder '" + placeholder.id + "' edit is a no-op.");
    if (placeholder.sourceText === "" && /\r?\n/u.test(request.after)) {
      fail("empty placeholder '" + placeholder.id + "' currently accepts exactly one line.");
    }
    if (placeholder.maxCharacters !== undefined && request.after.length > placeholder.maxCharacters) {
      fail("placeholder '" + placeholder.id + "' exceeds maxCharacters " + placeholder.maxCharacters + ".");
    }
    if (placeholder.maxLines !== undefined && request.after.split(/\r?\n/u).length > placeholder.maxLines) {
      fail("placeholder '" + placeholder.id + "' exceeds maxLines " + placeholder.maxLines + ".");
    }

    const compiled = {
      shapeName: placeholder.shapeName,
      placeholderType: placeholder.placeholderType,
      placeholderIndex: placeholder.placeholderIndex,
      before: placeholder.sourceText,
      after: request.after,
      sourceObjectKey: placeholder.sourceObjectKey,
      sourceObjectSha256: placeholder.sourceObjectSha256,
      sourceShapeId: placeholder.sourceShapeId,
      sourceCreationId: placeholder.sourceCreationId,
      sourceParagraphSha256s: [...placeholder.sourceParagraphSha256s],
    };
    if (placeholder.sourceText === "") {
      compiled.editMode = "populate-empty-placeholder";
    }
    return compiled;
  });
}

export function compileProfileDerivation(profileInput, request = {}) {
  const profile = validateDesignProfile(profileInput);
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("request must be an object.");

  const archetype = selectDesignArchetype(profile, request.archetype ?? {});
  const edits = compileEdits(archetype, request.edits);
  const preserveOnlySlides = Array.from({ length: profile.source.slideCount }, (_, index) => index + 1)
    .filter((slideNumber) => slideNumber !== archetype.sourceSlide);
  const editedShapeNames = edits.map((edit) => edit.shapeName);

  return {
    version: "0.1",
    derivationVersion: "g22-v1",
    mode: "clone-source-deck",
    source: profile.source.fileName,
    sourceSha256: profile.source.sha256.toLowerCase(),
    targetSlide: archetype.sourceSlide,
    edits,
    preserveOnlySlides,
    allowedDeviation: [
      "edited native text in " + editedShapeNames.length + " declared placeholder shape"
        + (editedShapeNames.length === 1 ? "" : "s") + " on slide " + archetype.sourceSlide,
    ],
    designBinding: {
      profileId: profile.id,
      archetypeId: archetype.id,
      sourceSlideId: archetype.sourceSlideId,
      layoutName: archetype.layoutName ?? null,
      masterName: archetype.masterName ?? null,
      orientation: archetype.orientation,
      preserveUndeclaredObjects: true,
      allowArbitraryImport: false,
      preservedShapeNames: [...archetype.chrome.preservedShapeNames],
      rimPairs: structuredClone(archetype.chrome.rimPairs),
      guides: structuredClone(profile.guides),
      logoIds: profile.logos
        .filter((logo) => logo.slideNumbers.includes(archetype.sourceSlide))
        .map((logo) => logo.id),
      themeSnapshot: structuredClone(profile.theme),
    },
  };
}

export async function loadAndCompileProfileDerivation(profilePath, request = {}) {
  const profile = await loadDesignProfile(profilePath);
  return compileProfileDerivation(profile, request);
}


export function compileProfileContentSpec(profileInput, contentSpec) {
  const profile = validateDesignProfile(profileInput);
  if (!contentSpec || typeof contentSpec !== "object" || Array.isArray(contentSpec)) fail("content spec must be an object.");
  const selector = contentSpec.targetSlide
    ? { id: profile.archetypes.find((item) => item.sourceSlide === contentSpec.targetSlide)?.id }
    : { layoutName: contentSpec.archetype };
  const archetype = selectDesignArchetype(profile, selector);
  if (!Array.isArray(contentSpec.replacements) || contentSpec.replacements.length === 0) fail("content spec replacements must be non-empty.");
  const byShape = new Map(archetype.placeholders.map((placeholder) => [placeholder.shapeName, placeholder]));
  const edits = contentSpec.replacements.map((replacement, index) => {
    const placeholder = byShape.get(replacement.shapeName);
    if (!placeholder) fail("content spec replacement[" + index + "] targets undeclared shape '" + replacement.shapeName + "'.");
    if (replacement.before !== placeholder.sourceText) fail("content spec source text mismatch for '" + replacement.shapeName + "'.");
    return { placeholderId: placeholder.id, after: replacement.after };
  });
  return compileProfileDerivation(profile, { archetype: { id: archetype.id }, edits });
}
