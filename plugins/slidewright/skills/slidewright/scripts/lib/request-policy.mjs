const ZERO_WIDTH_OR_DIRECTIONAL = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;

export const REQUEST_SCHEMA_VERSION = "slidewright-request/v1";
export const REQUEST_POLICY_VERSION = "slidewright-request-policy/v1";
export const IMMUTABLE_REQUEST_STAGES = Object.freeze(["policy", "compile", "fonts", "lint", "render", "audit", "delivery"]);
export const REQUEST_QUALITY_CONTRACT = Object.freeze({
  schemaVersion: "slidewright-request-quality/v1",
  geometryTolerancePx: 1,
  approvedFontSizesPt: Object.freeze([54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12]),
  minimumFontSizeByRolePt: Object.freeze({ eyebrow: 12, title: 28, body: 16, callout: 16, subheading: 16, subtitle: 16 }),
  minimumMarginPx: 64,
  minimumColumnGapPx: 24,
  maximumOccupancyRatio: 0.94,
  maximumTopLevelObjects: 12,
  minimumPeerGapPx: 12,
  warningsAreFailures: true,
  visibleTextMustBeNative: true,
  textOverlapAllowed: false,
  adaptiveCopyRelayoutRequired: true,
  maximumAdaptiveSlides: 200,
  promptMayControlStages: false,
  promptMayControlPaths: false,
  atomicPublicationRequired: true,
});

function normalizePrompt(prompt) {
  return prompt
    .normalize("NFKC")
    .replace(ZERO_WIDTH_OR_DIRECTIONAL, "")
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function maskDeclaredLiteralCopy(text) {
  return text.replace(/\b(?:display|show|include|quote|render)\b[^.!?]{0,80}?\b(?:literal|verbatim|audience-facing|slide copy)\b[^.!?]{0,20}?(?:`[^`]*`|"[^"]*"|'[^']*')/gu, (match) => match.replace(/(?:`[^`]*`|"[^"]*"|'[^']*')/gu, " <literal-copy> "));
}

function isProtectiveNegation(text, index) {
  const prefix = text.slice(Math.max(0, index - 40), index);
  return /(?:do not|don't|never|must not|cannot|can't|refuse to)\s+(?:ever\s+)?$/u.test(prefix);
}

function collectMatches(text, expression) {
  const matches = [];
  expression.lastIndex = 0;
  for (const match of text.matchAll(expression)) {
    if (!isProtectiveNegation(text, match.index ?? 0)) matches.push(match[0]);
  }
  return matches;
}

const RULES = Object.freeze([
  {
    ruleId: "SWP001",
    message: "The request attempts to bypass a mandatory build or verification stage.",
    remediation: "Keep compile, font audit, lint, render, and OOXML audit enabled; shorten or relayout content instead of disabling a gate.",
    expression: /\b(?:skip|bypass|disable|omit|ignore|avoid)\s+(?:the\s+)?(?:compile|compilation|font audit|font check|lint|linter|render|rendering|ooxml audit|audit|verification|quality checks?|qa|tests?)\b|\bwithout\s+(?:compile|compilation|lint|rendering?|audit|verification|qa|quality checks?)\b/gu,
  },
  {
    ruleId: "SWP002",
    message: "The request attempts to accept or conceal quality warnings or errors.",
    remediation: "Treat warnings and errors as build failures and repair the content or layout before export.",
    expression: /\b(?:allow|accept|ignore|hide|suppress|waive)\s+(?:all\s+|any\s+|the\s+)?(?:lint\s+)?(?:warnings?|errors?|failures?)\b|\bwarnings?\s+(?:are|is)\s+(?:fine|okay|ok|acceptable)\b/gu,
  },
  {
    ruleId: "SWP003",
    message: "The request attempts to rasterize visible text or flatten the slide into an image.",
    remediation: "Keep visible text and semantic content as native editable PowerPoint objects; rasterize only true visual assets.",
    expression: /\b(?:rasterize|flatten|convert|export|render|make)\s+(?:(?:all|the|visible)\s+){0,3}(?:text|words?|content|slide|deck|presentation)\s+(?:as|to|into)\s+(?:a\s+|one\s+)?(?:picture|image|screenshot|bitmap|png|jpeg|jpg)\b|\b(?:text|words?|content)\s+(?:can|may|should)\s+be\s+(?:an?\s+)?(?:image|picture|screenshot|bitmap)\b/gu,
  },
  {
    ruleId: "SWP004",
    message: "The request attempts to permit text overlap, clipping, overflow, or off-canvas placement.",
    remediation: "Relayout or split content so every text box remains separate, fully visible, and inside the slide canvas.",
    expression: /\b(?:allow|permit|accept|ignore|hide)\s+(?:any\s+|some\s+|the\s+)?(?:text(?:\s*boxes?)?\s+)?(?:overlap|overlapping|clipping|overflow|off[- ]canvas)\b|\b(?:overlap|clipping|overflow)\s+(?:is|are)\s+(?:fine|okay|ok|acceptable)\b/gu,
  },
  {
    ruleId: "SWP005",
    message: "The request demands fractional or sub-minimum presentation type.",
    remediation: "Use conventional whole-point sizes at or above the configured role minimum; shorten copy or change layout when it does not fit.",
    evaluate(text) {
      const matches = [];
      const expression = /\b(?:use|set|shrink|force|allow|permit|make)\b[^.!?]{0,48}?\b(\d+(?:\.\d+)?)\s*(?:pt|point|points)\b/gu;
      for (const match of text.matchAll(expression)) {
        if (isProtectiveNegation(text, match.index ?? 0)) continue;
        const value = Number(match[1]);
        if (!Number.isInteger(value) || value < 16) matches.push(match[0]);
      }
      return matches;
    },
  },
  {
    ruleId: "SWP006",
    message: "The request attempts to make visible text or semantic objects non-editable.",
    remediation: "Keep text, emphasis, shapes, charts, tables, and diagrams native and editable.",
    expression: /\b(?:make|lock|convert|flatten)\s+(?:all\s+|the\s+|visible\s+)?(?:text|content|objects?|shapes?|charts?|tables?|diagrams?)\s+(?:as\s+|to\s+|into\s+)?(?:non[- ]editable|uneditable|locked|outlines?|paths?)\b/gu,
  },
  {
    ruleId: "SWP007",
    message: "The request contains an attempted command, path, or process injection.",
    remediation: "Provide presentation content and design intent only; Slidewright never executes commands or accepts output paths from prompt text.",
    expression: /(?:\.\.\/|\.\.\\)|\b(?:powershell|pwsh|cmd\s*\/c|bash\s+-c|sh\s+-c|remove-item|new-item|invoke-expression|start-process|rm\s+-rf|curl[^.!?]{0,30}\|\s*(?:sh|bash)|wget[^.!?]{0,30}\|\s*(?:sh|bash)|touch\s+[^\s]+)\b/gu,
  },
  {
    ruleId: "SWP008",
    message: "The request attempts to override Slidewright's instruction or quality hierarchy.",
    remediation: "Keep the Slidewright skill and its quality contract authoritative; conflicting presentation instructions are rejected.",
    expression: /\b(?:ignore|disregard|override|forget|bypass)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|system|developer|skill|slidewright|quality|safety|formatting)(?:\s+(?:system|developer|skill|slidewright|quality|safety|formatting))?\s+(?:instructions?|rules?|contract|checks?|safeguards?|constraints?)\b/gu,
  },
]);

function envelopeDiagnostics(request) {
  const diagnostics = [];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return [{
      ruleId: "SWP000",
      severity: "error",
      message: "The request envelope must be a JSON object.",
      remediation: `Use schemaVersion '${REQUEST_SCHEMA_VERSION}' with a safe id, non-empty prompt, and inline deck specification.`,
    }];
  }
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION) diagnostics.push({
    ruleId: "SWP000",
    severity: "error",
    message: `Unsupported request schema '${request.schemaVersion ?? "<missing>"}'.`,
    remediation: `Set schemaVersion to '${REQUEST_SCHEMA_VERSION}'.`,
  });
  if (typeof request.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.id)) diagnostics.push({
    ruleId: "SWP000",
    severity: "error",
    message: "Request id must be 1-64 lowercase letters, digits, or hyphens and must begin with a letter or digit.",
    remediation: "Use a stable identifier such as 'quarterly-review'.",
  });
  if (typeof request.prompt !== "string" || request.prompt.trim() === "" || request.prompt.length > 100_000) diagnostics.push({
    ruleId: "SWP000",
    severity: "error",
    message: "Prompt must be a non-empty string no longer than 100,000 characters.",
    remediation: "Provide the original user prompt as bounded plain text.",
  });
  if (!request.spec || typeof request.spec !== "object" || Array.isArray(request.spec)) diagnostics.push({
    ruleId: "SWP000",
    severity: "error",
    message: "Request must include an inline deck specification object.",
    remediation: "Translate content and design intent into spec before invoking the immutable request runner.",
  });
  const allowed = new Set(["schemaVersion", "id", "prompt", "spec"]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length) diagnostics.push({
    ruleId: "SWP000",
    severity: "error",
    message: `Request contains unsupported control fields: ${unknown.sort().join(", ")}.`,
    remediation: "Remove output paths, commands, stage controls, and other fields; the runner owns all build mechanics.",
  });
  if (request?.spec && typeof request.spec === "object" && !Array.isArray(request.spec)) diagnostics.push(...specStructureDiagnostics(request.spec));
  return diagnostics;
}

function unknownKeys(value, allowed, objectPath, diagnostics) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) diagnostics.push({
    ruleId: "SWP009",
    severity: "error",
    message: `${objectPath} contains unsupported policy or structure fields: ${unknown.sort().join(", ")}.`,
    remediation: "Use only the strict request specification fields; quality thresholds, geometry, stages, validity, and output paths are runner-owned.",
  });
}

function inspectTextStructure(value, objectPath, diagnostics) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (Array.isArray(value.runs)) {
    unknownKeys(value, ["runs"], objectPath, diagnostics);
    value.runs.forEach((run, index) => unknownKeys(run, ["text", "bold", "italic", "color"], `${objectPath}.runs[${index}]`, diagnostics));
  } else if (Array.isArray(value.paragraphs)) {
    unknownKeys(value, ["paragraphs"], objectPath, diagnostics);
    value.paragraphs.forEach((paragraph, paragraphIndex) => {
      unknownKeys(paragraph, ["runs", "bullet", "level"], `${objectPath}.paragraphs[${paragraphIndex}]`, diagnostics);
      if (Array.isArray(paragraph?.runs)) paragraph.runs.forEach((run, runIndex) => unknownKeys(run, ["text", "bold", "italic", "color"], `${objectPath}.paragraphs[${paragraphIndex}].runs[${runIndex}]`, diagnostics));
    });
  } else {
    diagnostics.push({
      ruleId: "SWP009",
      severity: "error",
      message: `${objectPath} is an unsupported text control object.`,
      remediation: "Use a string, a runs object, or a paragraphs object without layout or policy fields.",
    });
  }
}

function inspectText(value, objectPath, diagnostics) {
  if (typeof value === "string") return;
  inspectTextStructure(value, objectPath, diagnostics);
}

function specStructureDiagnostics(spec) {
  const diagnostics = [];
  unknownKeys(spec, ["version", "title", "canvas", "layout", "theme", "coverage", "slides"], "spec", diagnostics);
  unknownKeys(spec.canvas, ["width", "height"], "spec.canvas", diagnostics);
  unknownKeys(spec.layout, ["margin"], "spec.layout", diagnostics);
  unknownKeys(spec.theme, ["fontFamily", "fallbackFontFamily", "colors"], "spec.theme", diagnostics);
  unknownKeys(spec.theme?.colors, ["background", "surface", "text", "muted", "subtle", "accent", "accentSoft", "border", "success"], "spec.theme.colors", diagnostics);
  unknownKeys(spec.coverage, ["topics"], "spec.coverage", diagnostics);
  if (Array.isArray(spec.coverage?.topics)) spec.coverage.topics.forEach((topic, index) => unknownKeys(topic, ["id", "title"], `spec.coverage.topics[${index}]`, diagnostics));
  if (spec.canvas && (spec.canvas.width !== 1280 || spec.canvas.height !== 720)) diagnostics.push({
    ruleId: "SWP009",
    severity: "error",
    message: "The guarded request path currently supports only the proven 1280x720 canvas.",
    remediation: "Use the proven canvas or treat another size as an unqualified developer workflow until a dedicated contract is added.",
  });
  if (spec.layout?.margin != null && (!Number.isFinite(spec.layout.margin) || spec.layout.margin < REQUEST_QUALITY_CONTRACT.minimumMarginPx)) diagnostics.push({
    ruleId: "SWP009",
    severity: "error",
    message: `The guarded request path requires a symmetric margin of at least ${REQUEST_QUALITY_CONTRACT.minimumMarginPx}px.`,
    remediation: "Remove the override or choose an equal larger outer margin.",
  });
  if (Array.isArray(spec.slides)) spec.slides.forEach((slide, index) => {
    const objectPath = `spec.slides[${index}]`;
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) return;
    const shared = ["id", "layout", "topicId", "coverageRole", "headlineSplit"];
    if (slide.layout === "hero") {
      unknownKeys(slide, [...shared, "eyebrow", "title", "body", "callout"], objectPath, diagnostics);
      inspectText(slide.title, `${objectPath}.title`, diagnostics);
      inspectText(slide.body, `${objectPath}.body`, diagnostics);
      inspectText(slide.callout, `${objectPath}.callout`, diagnostics);
    } else if (slide.layout === "two-column") {
      unknownKeys(slide, [...shared, "columnGap", "title", "left", "right"], objectPath, diagnostics);
      if (slide.columnGap != null && (!Number.isFinite(slide.columnGap) || slide.columnGap < REQUEST_QUALITY_CONTRACT.minimumColumnGapPx)) diagnostics.push({
        ruleId: "SWP009", severity: "error", message: `${objectPath}.columnGap weakens the guarded ${REQUEST_QUALITY_CONTRACT.minimumColumnGapPx}px gap floor.`, remediation: "Use a gap of at least 24px or change layout.",
      });
      inspectText(slide.title, `${objectPath}.title`, diagnostics);
      for (const side of ["left", "right"]) {
        unknownKeys(slide[side], ["heading", "body"], `${objectPath}.${side}`, diagnostics);
        inspectText(slide[side]?.body, `${objectPath}.${side}.body`, diagnostics);
      }
    } else if (slide.layout === "section") {
      unknownKeys(slide, [...shared, "title", "subtitle"], objectPath, diagnostics);
      inspectText(slide.title, `${objectPath}.title`, diagnostics);
      inspectText(slide.subtitle, `${objectPath}.subtitle`, diagnostics);
    }
    unknownKeys(slide.headlineSplit, ["ratio", "side"], `${objectPath}.headlineSplit`, diagnostics);
  });
  return diagnostics;
}

export function evaluateRequestPolicy(request) {
  const diagnostics = envelopeDiagnostics(request);
  const normalizedPrompt = typeof request?.prompt === "string" ? normalizePrompt(request.prompt) : "";
  const controlPrompt = maskDeclaredLiteralCopy(normalizedPrompt);
  if (!diagnostics.length) {
    for (const rule of RULES) {
      const matches = rule.evaluate ? rule.evaluate(controlPrompt) : collectMatches(controlPrompt, rule.expression);
      if (!matches.length) continue;
      diagnostics.push({
        ruleId: rule.ruleId,
        severity: "error",
        message: rule.message,
        remediation: rule.remediation,
        evidence: [...new Set(matches)].sort(),
      });
    }
  }
  return {
    schemaVersion: REQUEST_POLICY_VERSION,
    valid: diagnostics.length === 0,
    promptTreatedAsData: true,
    promptExecuted: false,
    immutableStages: [...IMMUTABLE_REQUEST_STAGES],
    qualityContract: REQUEST_QUALITY_CONTRACT,
    normalizedPrompt,
    controlPrompt,
    diagnostics,
  };
}

export { normalizePrompt };
