const REVIEW_SCHEMA_VERSION = "slidewright-executive-review/v1";
const REVIEW_MODE_OFF = "off";
const REVIEW_MODE_OVERLAY = "executive-overlay";
const NOTE_WIDTH = 336;
const NOTE_HEIGHT = 82;
const NOTE_GAP = 12;
const EDGE_INSET = 24;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function shapeText(shape) {
  if (shape.type === "table") return shape.table.values.flat().join(" ");
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

function titleLooksGeneric(text) {
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length > 10) return false;
  return !/\b(?:is|are|was|were|will|can|could|should|must|drives?|creates?|reduces?|increases?|requires?|enables?|shows?|outperforms?|improves?|declines?|grows?|wins?|loses?)\b/iu.test(text);
}

function reviewCandidates(slide) {
  const titleShape = target(slide, (shape) => shape.role === "title");
  const titleText = shapeText(titleShape);
  const textShapes = slide.shapes.filter((shape) => shape.type === "text");
  const allText = slide.shapes.map(shapeText).join(" ");
  const candidates = [];
  const evidenceShape = target(slide, (shape) => shape.type === "table" || /(?:\d|%|\$|€|£)/u.test(shapeText(shape)), titleShape);

  if (/(?:\d|%|\$|€|£)/u.test(allText) || slide.layout === "table") candidates.push({
    rank: 100,
    category: "evidence-validation",
    targetShape: evidenceShape,
    note: slide.layout === "table" ? "Validate the table's units, definitions, and source." : "Validate this claim, number, and source.",
    rationale: "Executive readers should be able to trace quantitative claims and tabular evidence to a defensible source.",
  });

  const dense = [...textShapes]
    .filter((shape) => ["body", "callout", "subtitle"].includes(shape.role))
    .sort((left, right) => {
      const leftRatio = Number(left.fit?.estimatedHeight ?? 0) / Math.max(1, Number(left.fit?.availableHeight ?? left.position.height));
      const rightRatio = Number(right.fit?.estimatedHeight ?? 0) / Math.max(1, Number(right.fit?.availableHeight ?? right.position.height));
      return rightRatio - leftRatio;
    })[0];
  const densityRatio = dense ? Number(dense.fit?.estimatedHeight ?? 0) / Math.max(1, Number(dense.fit?.availableHeight ?? dense.position.height)) : 0;
  if (slide.layout !== "section" && dense && (densityRatio >= 0.86 || dense.style?.fontSizePt === dense.fit?.minSizePt)) candidates.push({
    rank: 90,
    category: "density-adjustment",
    targetShape: dense,
    note: "Consider cutting or splitting this dense passage.",
    rationale: "The content fits mechanically but is close enough to its capacity that an executive edit may improve scanability.",
  });

  if (slide.layout !== "section" && (titleText.length > 86 || Number(titleShape?.fit?.lines ?? 1) > 1)) candidates.push({
    rank: 80,
    category: "message-clarity",
    targetShape: titleShape,
    note: "Tighten this to a one-line executive takeaway.",
    rationale: "A constrained or multi-line headline should communicate the conclusion before the supporting detail.",
  });
  else if (slide.layout !== "section" && titleLooksGeneric(titleText)) candidates.push({
    rank: 70,
    category: "message-clarity",
    targetShape: titleShape,
    note: "Sharpen this into the slide's decision or takeaway.",
    rationale: "The headline appears topic-led rather than conclusion-led and merits a human message check.",
  });

  if (slide.layout === "hero") candidates.push({
    rank: 65,
    category: "decision-relevance",
    targetShape: target(slide, (shape) => shape.role === "callout", titleShape),
    note: "Confirm the decision owner, threshold, and timing.",
    rationale: "A decision page should make the accountable owner, success threshold, and decision timing explicit.",
  });
  else if (slide.layout === "two-column") candidates.push({
    rank: 60,
    category: "decision-relevance",
    targetShape: target(slide, (shape) => shape.id.endsWith("-left-body"), titleShape),
    note: "Confirm this comparison is decision-relevant and complete.",
    rationale: "Paired columns can imply a comparison framework; a human should validate that the dimensions are complete and useful.",
  });
  else if (slide.layout === "icon-list") candidates.push({
    rank: 60,
    category: "decision-relevance",
    targetShape: target(slide, (shape) => shape.role === "semantic-card", titleShape),
    note: "Confirm these are the right distinct priorities for this audience.",
    rationale: "A repeated-card framework should be mutually distinct and aligned to the audience's decision.",
  });
  else if (slide.layout === "section") candidates.push({
    rank: 50,
    category: "storyline-validation",
    targetShape: titleShape,
    note: "Confirm this section advances the overall storyline.",
    rationale: "Section transitions need a human check for narrative logic and audience relevance.",
  });
  else if (!candidates.length) candidates.push({
    rank: 40,
    category: "storyline-validation",
    targetShape: titleShape,
    note: "Confirm the implication and audience relevance.",
    rationale: "A partner-level review should validate the implication even when deterministic layout checks pass.",
  });

  return candidates
    .filter((item) => item.targetShape)
    .sort((left, right) => right.rank - left.rank || left.category.localeCompare(right.category))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.category === item.category && candidate.targetShape.id === item.targetShape.id) === index)
    .slice(0, 2);
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
          note: candidate.note,
          rationale: candidate.rationale,
          targetPosition: structuredClone(candidate.targetShape.position),
          overlayPosition: position,
          editable: true,
          manuallyRemovable: true,
        };
      });
    })
    : [];
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    mode,
    canonicalDeckModified: false,
    reviewCopyRequired: mode === REVIEW_MODE_OVERLAY,
    style: {
      fill: "#FFF2CC",
      border: "#D6A800",
      text: "#1F2937",
      label: "#7A5C00",
      fontSizePt: 14,
      labelSizePt: 12,
    },
    findings,
    counts: {
      slidesReviewed: plan.slides.length,
      slidesFlagged: new Set(findings.map((item) => item.slideIndex)).size,
      findings: findings.length,
    },
  };
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
