import { measureText } from "./typography.mjs";

const REVIEW_SCHEMA_VERSION = "slidewright-executive-review/v2";
const REVIEW_MODE_OFF = "off";
const REVIEW_MODE_OVERLAY = "executive-overlay";
const NOTE_WIDTH = 470;
const NOTE_HEIGHT = 230;
const NOTE_GAP = 12;
const EDGE_INSET = 24;
const GENERIC_REVIEW_SENTENCES = new Set([
  "validate this claim, number, and source",
  "sharpen this into the slide's decision or takeaway",
  "consider cutting or splitting this dense passage",
  "confirm this section advances the overall storyline",
  "confirm the implication and audience relevance",
]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function shapeText(shape = {}) {
  if (shape.type === "table") return shape.table?.values?.flat().join(" ") ?? "";
  return (shape.text?.paragraphs ?? [])
    .flatMap((paragraph) => paragraph.runs ?? [])
    .map((run) => run.text ?? "")
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function target(slide, predicate, fallback = null) {
  return slide.shapes.find(predicate) ?? fallback ?? slide.shapes.find((shape) => shape.role === "title") ?? slide.shapes[0];
}

function excerpt(value, maximum = 64) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function quote(value, maximum = 64) {
  return `“${excerpt(value, maximum).replace(/[“”]/gu, "\"") || "untitled element"}”`;
}

function slideTitle(slide) {
  return shapeText(target(slide, (shape) => shape.role === "title")) || slide.id;
}

function provenanceClause(slide, targetShape) {
  const provenance = slide.designProvenance;
  if (!provenance?.conceptId || !provenance.referenceSlides?.length) return null;
  return `Ref ${targetShape.id}: slide ${provenance.referenceSlides[0]}, ${quote(provenance.selectedConcept, 18)} (${provenance.compositionModel}).`;
}

function decisionAnchor(value) {
  const stop = new Set(["about", "after", "before", "from", "into", "just", "only", "that", "their", "these", "this", "until", "when", "with", "without"]);
  const tokens = (String(value ?? "").toLowerCase().match(/[a-z0-9]{4,}/gu) ?? []).filter((token) => !stop.has(token)).slice(0, 3);
  return tokens.length ? `“${tokens.join(" ")}”` : "the decision";
}

function relationshipIntent(slide, headings, bodies, titleText) {
  const declared = slide.reviewIntent?.relationship;
  if (declared) return declared;
  const headingText = headings.map(shapeText).join(" ").toLowerCase();
  const bodyText = bodies.map(shapeText).join(" ").toLowerCase();
  const title = titleText.toLowerCase();
  const temporal = /\b(?:after|before|follow|handoff|next|phase|stage|step|then|until)\b/u;
  if (temporal.test(title) && temporal.test(bodyText)) return "sequence-handoff";
  if (/\b(?:accountable|authority|escalat\w*|own(?:s|ed|ership)?|responsib\w*)\b/u.test(bodyText)) return "role-boundary";
  if (/\b(?:crosswalk|dimension|lens|map|stakeholder|view)\b/u.test(`${title} ${headingText}`)) return "crosswalk";
  return "comparison-selection";
}

function tableRelationshipIntent(slide, headers) {
  const declared = slide.reviewIntent?.relationship;
  if (declared) return declared;
  const normalized = headers.toLowerCase();
  if (/\b(?:accountable|decision|evidence|owner|threshold)\b/u.test(normalized)) return "decision-ownership";
  if (/\b(?:action|category|indicator|move|signal|type)\b/u.test(normalized)) return "category-trigger";
  if (/\b(?:approach|benefit|guardrail|method|risk|why)\b/u.test(normalized)) return "application-trigger";
  return "evidence-rule";
}

function groundedFinding({ slide, targetShape, category, subject, diagnosis, impact, recommendation }) {
  const title = slideTitle(slide);
  const sourceContext = provenanceClause(slide, targetShape);
  const exactObject = { shapeId: targetShape.id, excerpt: excerpt(shapeText(targetShape)) };
  const diagnosisSentence = `Target ${targetShape.id} ${quote(subject, 40)}: ${diagnosis}`;
  const impactSentence = `Executive risk on ${slide.id} ${quote(title)}: ${impact}`;
  const recommendationSentence = `Revise ${targetShape.id}: ${recommendation.replace(/[.!?]+$/u, "")}.${sourceContext ? ` ${sourceContext}` : ""}`;
  return {
    rank: 100,
    category,
    targetShape,
    exactObject,
    diagnosis: diagnosisSentence,
    executiveImpact: impactSentence,
    recommendation: recommendationSentence,
    provenanceContext: sourceContext,
    note: `${diagnosisSentence} ${impactSentence} ${recommendationSentence}`,
    rationale: `${diagnosisSentence} ${impactSentence}`,
  };
}

function reviewCandidates(slide) {
  const titleShape = target(slide, (shape) => shape.role === "title");
  const titleText = slideTitle(slide);
  if (slide.layout === "table") {
    const table = target(slide, (shape) => shape.type === "table", titleShape);
    const headerValues = table.table?.values?.[0] ?? [];
    const headers = headerValues.join(" / ") || shapeText(table);
    const rows = Math.max(0, (table.table?.values?.length ?? 1) - 1);
    const firstSemanticColumn = headerValues[0] === "#" ? 1 : 0;
    const rowLabels = (table.table?.values ?? []).slice(1).map((row) => row[firstSemanticColumn]).filter(Boolean);
    const relationship = tableRelationshipIntent(slide, headers);
    if (relationship === "decision-ownership") return [groundedFinding({
      slide, targetShape: table, category: "decision-ownership", subject: `${headers} (${rows} rows)`,
      diagnosis: `${quote(rowLabels.slice(0, 2).join(" / "))} names decisions but assigns no owner or evidence standard.`,
      impact: "the listed decisions may remain discussion rather than accountable choices.",
      recommendation: `add an owner/evidence field and validate the threshold for ${quote(rowLabels[0] || headers)}.`,
    })];
    if (relationship === "category-trigger") return [groundedFinding({
      slide, targetShape: table, category: "category-trigger", subject: `${headers} (${rows} rows)`,
      diagnosis: `${quote(rowLabels.slice(0, 3).join(" / "))} names categories but provides no observable action trigger.`,
      impact: "leaders can classify the same issue differently and choose conflicting moves.",
      recommendation: `add one trigger per category, starting with ${quote(rowLabels[0] || headers)}, and test one representative example through the grid.`,
    })];
    if (relationship === "application-trigger") return [groundedFinding({
      slide, targetShape: table, category: "application-trigger", subject: `${headers} (${rows} rows)`,
      diagnosis: `${quote(rowLabels.slice(0, 2).join(" / "))} explains methods and safeguards but no choice condition.`,
      impact: "the safeguards limit action without directing which option to use.",
      recommendation: `add a 'use when' trigger for ${quote(rowLabels[0] || headers)} and test every safeguard before adoption.`,
    })];
    return [groundedFinding({
      slide, targetShape: table, category: "evidence-and-decision-rule", subject: `${headers} (${rows} rows)`,
      diagnosis: `${quote(rowLabels.slice(0, 2).join(" / "))} is organized, but the rule connecting the ${rows} rows to a decision remains implicit.`,
      impact: "readers can scan the evidence without knowing what changes the recommended action.",
      recommendation: "state one governing decision rule above the table and highlight the row that currently controls it.",
    })];
  }
  if (slide.layout === "two-column") {
    const headings = slide.shapes.filter((shape) => shape.role === "subheading");
    const bodies = slide.shapes.filter((shape) => shape.role === "body");
    const primary = headings[0] ?? titleShape;
    const headingLabels = headings.map(shapeText).filter(Boolean);
    const leftLabel = headingLabels[0] || "left panel";
    const rightLabel = headingLabels[1] || "right panel";
    const rightReference = quote(rightLabel, 20);
    const labels = headingLabels.join(" versus ");
    const relationship = relationshipIntent(slide, headings, bodies, titleText);
    if (relationship === "sequence-handoff") return [groundedFinding({
      slide, targetShape: primary, category: "sequence-handoff", subject: labels || titleText,
      diagnosis: `the target must hand off into ${rightReference}, but the panels read as a choice between peers.`,
      impact: "a reader can complete the first obligation and miss the handoff into the second.",
      recommendation: `show the target leading to ${rightReference}, with an exit condition, owner, and handoff.`,
    })];
    if (relationship === "role-boundary") return [groundedFinding({
      slide, targetShape: primary, category: "role-boundary", subject: labels || titleText,
      diagnosis: `the target and ${rightReference} both influence the process, but their authority boundary is absent.`,
      impact: "the two roles can duplicate actions or leave a disputed decision unowned.",
      recommendation: `state whether the target or ${rightReference} owns procedure, outcome, escalation, and handoff.`,
    })];
    if (relationship === "crosswalk") return [groundedFinding({
      slide, targetShape: primary, category: "crosswalk-logic", subject: labels || titleText,
      diagnosis: `no element-to-element mapping from the target to ${rightReference} is shown.`,
      impact: "readers cannot see how an input in one view changes a criterion in the other.",
      recommendation: `connect one named target element to its affected condition in ${rightReference}.`,
    })];
    return [groundedFinding({
      slide, targetShape: primary, category: "comparison-decision-rule", subject: labels || titleText,
      diagnosis: `the condition selecting the target over ${rightReference} is not explicit.`,
      impact: "readers may combine incompatible approaches or default to personal preference.",
      recommendation: `add a one-line target-versus-${excerpt(rightLabel, 20)} selection rule tied to ${decisionAnchor(titleText)}, then validate it with one example.`,
    })];
  }
  if (slide.layout === "icon-list") {
    const labels = slide.shapes.filter((shape) => shape.role === "subheading");
    const primary = labels[0] ?? titleShape;
    const labelText = labels.map(shapeText).filter(Boolean).join(" / ");
    const variant = slide.designProvenance?.compositionVariant;
    if (variant === "triangular-cycle") return [groundedFinding({
      slide, targetShape: primary, category: "diagram-relationship", subject: labelText || titleText,
      diagnosis: "the triangle names three parts, but its center and edges do not define their relationship.",
      impact: "leaders cannot tell whether this is a cycle, hierarchy, or parallel lenses.",
      recommendation: "label the edges or center, then validate the intended reading.",
    })];
    if (variant === "four-callout-quadrant") return [groundedFinding({
      slide, targetShape: primary, category: "framework-order", subject: labelText || titleText,
      diagnosis: `the four callouts beginning with ${quote(shapeText(primary) || titleText)} fit the quadrant, but no visible reading order is defined.`,
      impact: "a reader cannot tell which action starts the sequence or whether the actions run concurrently.",
      recommendation: `number the callouts from ${quote(shapeText(primary) || titleText)} onward, or mark them concurrent, then validate the reading order once.`,
    })];
    return [groundedFinding({
      slide, targetShape: primary, category: "framework-distinctness", subject: labelText || titleText,
      diagnosis: "the framework names peer elements but leaves their priority, sequence, and trade-off logic unstated.",
      impact: "leaders cannot tell which component controls the next action.",
      recommendation: "add an explicit order, dependency, or decision criterion to the native diagram.",
    })];
  }
  if (slide.layout === "section") {
    const subtitle = target(slide, (shape) => shape.role === "subtitle", titleShape);
    const transitionText = shapeText(subtitle) || titleText;
    return [groundedFinding({
      slide, targetShape: subtitle, category: "storyline-transition", subject: transitionText,
      diagnosis: `the ${decisionAnchor(titleText)} transition states a principle but does not preview the question the section will resolve.`,
      impact: "the page reads as navigation rather than an argumentative turn.",
      recommendation: "replace the subtitle with one decision question that the following slides explicitly answer.",
    })];
  }
  if (slide.layout === "hero") {
    const callout = target(slide, (shape) => shape.role === "callout", titleShape);
    const calloutText = shapeText(callout);
    if (/\b(?:strongest|always|never|best|only)\b/iu.test(calloutText)) return [groundedFinding({
      slide, targetShape: callout, category: "claim-validation", subject: calloutText || titleText,
      diagnosis: "the callout uses an absolute executive claim without a named principle, example, or boundary condition.",
      impact: "a skeptical audience can challenge the opening before accepting the proposed approach.",
      recommendation: `cite evidence for ${decisionAnchor(calloutText || titleText)} or soften the absolute language, then verify it against the source material.`,
    })];
    return [groundedFinding({
      slide, targetShape: callout, category: "claim-operationalization", subject: shapeText(callout) || titleText,
      diagnosis: "the imperatives are memorable but define neither a trigger nor a decision owner.",
      impact: "the audience cannot tell when to apply the rule in practice.",
      recommendation: `write one if-trigger / owner / action rule for ${decisionAnchor(calloutText || titleText)} and test it against one documented example.`,
    })];
  }
  const bodies = slide.shapes.filter((shape) => ["body", "callout", "subtitle"].includes(shape.role));
  const body = bodies.sort((left, right) => shapeText(right).length - shapeText(left).length)[0] ?? titleShape;
  return [groundedFinding({
    slide, targetShape: body, category: "implication-clarity", subject: shapeText(body) || titleText,
    diagnosis: "the explanation leaves its implication implicit.",
    impact: "the required action must be inferred.",
    recommendation: "end the passage with one explicit “therefore” action.",
  })];
}

function overlaps(left, right) {
  return left.left < right.left + right.width
    && left.left + left.width > right.left
    && left.top < right.top + right.height
    && left.top + left.height > right.top;
}

function overlayPosition({ canvas, targetPosition, noteIndex, occupied }) {
  const preferredLeft = targetPosition.left + targetPosition.width - NOTE_WIDTH;
  const left = clamp(preferredLeft, EDGE_INSET, canvas.width - EDGE_INSET - NOTE_WIDTH);
  const topCandidates = [
    targetPosition.top + 8,
    targetPosition.top + targetPosition.height - NOTE_HEIGHT - 8,
    EDGE_INSET + noteIndex * (NOTE_HEIGHT + NOTE_GAP),
    canvas.height - EDGE_INSET - NOTE_HEIGHT - noteIndex * (NOTE_HEIGHT + NOTE_GAP),
  ];
  for (const candidateTop of topCandidates) {
    const position = { left: Math.round(left), top: Math.round(clamp(candidateTop, EDGE_INSET, canvas.height - EDGE_INSET - NOTE_HEIGHT)), width: NOTE_WIDTH, height: NOTE_HEIGHT };
    if (!occupied.some((item) => overlaps(position, item))) return position;
  }
  throw new Error("Executive-review findings cannot be placed without overlapping another review note.");
}

function normalizedSentence(value) {
  return value.toLowerCase().replace(/[“”"'`]/gu, "").replace(/[^a-z0-9]+/gu, " ").trim();
}

function semanticReviewSignature(finding) {
  const diagnosis = String(finding.diagnosis ?? "").replace(/^Target\s+[^:]+:\s*/u, "");
  const recommendation = String(finding.recommendation ?? "")
    .replace(/^Revise\s+[^:]+:\s*/u, "")
    .replace(/\s+Reference for [^.]+:.*$/u, "");
  return normalizedSentence(`${diagnosis} ${recommendation}`);
}

function noteFit(note) {
  return measureText({
    text: `PARTNER CHECK\n${note}`,
    width: NOTE_WIDTH,
    height: NOTE_HEIGHT,
    fontSizePt: 12,
    lineHeight: 1.05,
    insets: { top: 8, right: 10, bottom: 8, left: 10 },
    glyphFactor: 0.5,
    maxLines: 12,
  });
}

export function validateExecutiveReviewSpecificity(review, plan) {
  const diagnostics = [];
  const sentences = new Map();
  const semanticBodies = new Map();
  for (const finding of review.findings ?? []) {
    const slide = plan.slides?.[finding.slideIndex - 1];
    const targetShape = slide?.shapes?.find((shape) => shape.id === finding.targetShapeId);
    if (!slide || !targetShape) diagnostics.push(`${finding.id}:target`);
    if (!finding.exactObject?.shapeId || finding.exactObject.shapeId !== finding.targetShapeId || !finding.exactObject.excerpt) diagnostics.push(`${finding.id}:exact-object`);
    for (const field of ["diagnosis", "executiveImpact", "recommendation"]) if (typeof finding[field] !== "string" || finding[field].trim().length < 24) diagnostics.push(`${finding.id}:${field}`);
    if (!finding.noteFit?.fits) diagnostics.push(`${finding.id}:note-overflow`);
    if (slide?.designProvenance?.conceptId && (!finding.provenanceContext || !finding.note.includes(String(slide.designProvenance.referenceSlides[0])))) diagnostics.push(`${finding.id}:provenance`);
    const normalizedNote = normalizedSentence(finding.note);
    if ([...GENERIC_REVIEW_SENTENCES].some((sentence) => normalizedNote === normalizedSentence(sentence))) diagnostics.push(`${finding.id}:generic`);
    for (const sentence of finding.note.split(/(?<=[.!?])\s+/u).map(normalizedSentence).filter(Boolean)) {
      if (sentences.has(sentence)) diagnostics.push(`${finding.id}:duplicate-sentence-${sentence}-with-${sentences.get(sentence)}`);
      else sentences.set(sentence, finding.id);
    }
    const semanticBody = semanticReviewSignature(finding);
    if (semanticBody && semanticBodies.has(semanticBody)) diagnostics.push(`${finding.id}:duplicate-semantic-body-with-${semanticBodies.get(semanticBody)}`);
    else if (semanticBody) semanticBodies.set(semanticBody, finding.id);
  }
  return { schemaVersion: "slidewright-executive-review-specificity/v1", valid: diagnostics.length === 0, diagnostics };
}

export function buildExecutiveReview(plan, mode = REVIEW_MODE_OFF) {
  if (![REVIEW_MODE_OFF, REVIEW_MODE_OVERLAY].includes(mode)) throw new Error(`Unsupported executive review mode '${mode}'.`);
  const findings = mode === REVIEW_MODE_OVERLAY
    ? plan.slides.flatMap((slide, slideIndex) => {
      const occupied = [];
      return reviewCandidates(slide).map((candidate, noteIndex) => {
        const position = overlayPosition({ canvas: plan.canvas, targetPosition: candidate.targetShape.position, noteIndex, occupied });
        occupied.push(position);
        return {
          id: `SW-E6-${String(slideIndex + 1).padStart(2, "0")}-${String(noteIndex + 1).padStart(2, "0")}`,
          slideId: slide.id,
          slideIndex: slideIndex + 1,
          targetShapeId: candidate.targetShape.id,
          category: candidate.category,
          exactObject: candidate.exactObject,
          diagnosis: candidate.diagnosis,
          executiveImpact: candidate.executiveImpact,
          recommendation: candidate.recommendation,
          provenanceContext: candidate.provenanceContext,
          note: candidate.note,
          noteFit: noteFit(candidate.note),
          rationale: candidate.rationale,
          targetPosition: structuredClone(candidate.targetShape.position),
          overlayPosition: position,
          editable: true,
          manuallyRemovable: true,
        };
      });
    })
    : [];
  const review = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    mode,
    canonicalDeckModified: false,
    reviewCopyRequired: mode === REVIEW_MODE_OVERLAY,
    style: {
      fill: "#FFF2CC",
      border: "#D6A800",
      text: "#1F2937",
      label: "#7A5C00",
      fontSizePt: 12,
      labelSizePt: 12,
    },
    findings,
    counts: {
      slidesReviewed: plan.slides.length,
      slidesFlagged: new Set(findings.map((item) => item.slideIndex)).size,
      findings: findings.length,
    },
  };
  const specificity = validateExecutiveReviewSpecificity(review, plan);
  if (!specificity.valid) throw new Error(`Executive-review specificity failed: ${specificity.diagnostics.join(", ")}.`);
  review.specificity = specificity;
  return review;
}

export function addExecutiveReviewOverlays(slide, findings, review, typeface) {
  for (const finding of findings) {
    const textbox = slide.shapes.add({
      geometry: "roundRect",
      name: finding.id,
      position: finding.overlayPosition,
      fill: review.style.fill,
      line: { style: "solid", fill: review.style.border, width: 2 },
      borderRadius: "rounded-lg",
    });
    textbox.text.set([
      [{ run: "PARTNER CHECK", textStyle: { bold: true, fontSize: `${review.style.labelSizePt}pt`, typeface, color: review.style.label } }],
      [{ run: finding.note, textStyle: { bold: false, fontSize: `${review.style.fontSizePt}pt`, typeface, color: review.style.text } }],
    ]);
    textbox.text.style = {
      color: review.style.text,
      alignment: "left",
      verticalAlignment: "middle",
      autoFit: "none",
      wrap: "square",
      insets: { top: 8, right: 10, bottom: 8, left: 10 },
      typeface,
      lineSpacing: 1.05,
    };
  }
}

export {
  REVIEW_MODE_OFF,
  REVIEW_MODE_OVERLAY,
  REVIEW_SCHEMA_VERSION,
};
