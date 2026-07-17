import { lintPlan } from "./linter.mjs";

function diagnostic(ruleId, slideId, objectId, message, suggestion) {
  return { ruleId, severity: "error", slideId, objectId, message, suggestion };
}

function renderedTextHeight(element) {
  const runs = (element.paragraphs ?? []).flatMap((paragraph) => paragraph.runs ?? []);
  const maximumFontPx = Math.max(0, ...runs.map((run) => Number(run.fontSize) || 0));
  const maximumLineSpacing = Math.max(1, ...runs.map((run) => Number(run.lineSpacing) || 1));
  const paragraphSpacingPx = (element.paragraphs ?? []).reduce(
    (total, paragraph) => total + ((Number(paragraph.spaceBefore ?? 0) + Number(paragraph.spaceAfter ?? 0)) / 100) * (96 / 72),
    0,
  );
  return maximumFontPx * maximumLineSpacing * Number(element.textLayout?.lineCount ?? 0) + paragraphSpacingPx;
}

function sameInsets(expected, actual, tolerance = 0.01) {
  return ["top", "right", "bottom", "left"].every((key) => Math.abs(Number(expected?.[key] ?? 0) - Number(actual?.[key] ?? 0)) <= tolerance);
}

export function lintRenderedLayouts(plan, layouts) {
  const diagnostics = [];
  const realized = structuredClone(plan);

  for (let slideIndex = 0; slideIndex < realized.slides.length; slideIndex += 1) {
    const slide = realized.slides[slideIndex];
    const layout = layouts[slideIndex];
    if (!layout || !Array.isArray(layout.elements)) {
      diagnostics.push(diagnostic("SW017", slide.id, null, "Rendered layout export is missing for this slide.", "Regenerate the slide layout export and require one unambiguous element per planned object."));
      continue;
    }
    const elementsByName = new Map();
    for (const element of layout.elements) {
      if (!elementsByName.has(element.name)) elementsByName.set(element.name, []);
      elementsByName.get(element.name).push(element);
    }
    for (const shape of slide.shapes ?? []) {
      const matches = elementsByName.get(shape.id) ?? [];
      if (matches.length !== 1) {
        diagnostics.push(diagnostic("SW017", slide.id, shape.id, `Expected one rendered object named '${shape.id}', found ${matches.length}.`, "Preserve stable unique object names from plan through layout export."));
        continue;
      }
      const element = matches[0];
      if (!Array.isArray(element.bbox) || element.bbox.length !== 4) {
        diagnostics.push(diagnostic("SW017", slide.id, shape.id, "Rendered object has no usable bounding box.", "Require renderer layout metadata with a four-value pixel bounding box."));
        continue;
      }
      const [left, top, width, height] = element.bbox.map(Number);
      shape.position = { left, top, width, height };
      if (shape.type === "text") {
        if (!sameInsets(shape.style?.insets, element.resolvedTextStyle?.insets)) diagnostics.push(
          diagnostic("SW023", slide.id, shape.id, "Rendered text insets differ from the tokenized plan.", "Preserve the same uniform inset token through native export."),
        );
        const expectedParagraphs = shape.text?.paragraphs ?? [];
        const actualParagraphs = element.paragraphs ?? [];
        if (expectedParagraphs.length && (actualParagraphs.length !== expectedParagraphs.length || expectedParagraphs.some((paragraph, index) => {
          const actual = actualParagraphs[index];
          return Number(actual?.spaceBefore ?? 0) !== Math.round(Number(paragraph.spaceBeforePt ?? 0) * 100)
            || Number(actual?.spaceAfter ?? 0) !== Math.round(Number(paragraph.spaceAfterPt ?? 0) * 100);
        }))) diagnostics.push(
          diagnostic("SW028", slide.id, shape.id, "Rendered native paragraph spacing differs from the 0/6/12pt plan.", "Preserve paragraph count and exact DrawingML spacing values through export."),
        );
        const actualLines = Number(element.textLayout?.lineCount);
        if (!Number.isFinite(actualLines)) {
          diagnostics.push(diagnostic("SW017", slide.id, shape.id, "Rendered text has no actual line count.", "Require textLayout.lineCount in the renderer layout export."));
        } else {
          shape.fit.lines = actualLines;
          const insets = element.resolvedTextStyle?.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
          const availableHeight = height - Number(insets.top ?? 0) - Number(insets.bottom ?? 0);
          const requiredHeight = renderedTextHeight(element);
          if (requiredHeight > availableHeight + 0.5) diagnostics.push(
            diagnostic("SW016", slide.id, shape.id, `Rendered text needs approximately ${requiredHeight.toFixed(1)}px but only ${availableHeight.toFixed(1)}px is available.`, "Increase the text frame, reduce copy, or choose a valid larger-capacity layout before export."),
          );
        }
      }
    }
  }

  const realizedReport = lintPlan(realized);
  diagnostics.push(...realizedReport.diagnostics);
  const counts = diagnostics.reduce(
    (acc, item) => ({ ...acc, [item.severity]: (acc[item.severity] ?? 0) + 1 }),
    { error: 0, warning: 0 },
  );
  return {
    valid: diagnostics.length === 0,
    counts,
    diagnostics,
    planHash: plan.build?.deterministicHash ?? null,
    renderedSlides: layouts.length,
  };
}
