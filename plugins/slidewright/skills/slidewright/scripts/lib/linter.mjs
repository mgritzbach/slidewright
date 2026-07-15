import { textFromRuns } from "./typography.mjs";

function diagnostic(ruleId, severity, slideId, objectId, message, suggestion) {
  return { ruleId, severity, slideId, objectId, message, suggestion };
}

function nearlyEqual(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

export function lintPlan(plan) {
  const diagnostics = [];
  const tolerance = plan.layout?.geometryTolerance ?? 1;
  const approved = new Set(plan.layout?.approvedFontSizesPt ?? []);

  for (const slide of plan.slides ?? []) {
    const outer = {
      left: slide.frame.left,
      top: slide.frame.top,
      right: plan.canvas.width - slide.frame.left - slide.frame.width,
      bottom: plan.canvas.height - slide.frame.top - slide.frame.height,
    };
    if (!nearlyEqual(outer.left, outer.right, tolerance) || !nearlyEqual(outer.top, outer.bottom, tolerance)) {
      diagnostics.push(
        diagnostic(
          "SW006",
          "error",
          slide.id,
          null,
          `Outer margins are asymmetric: ${JSON.stringify(outer)}.`,
          "Use equal left/right and top/bottom margins or declare an intentional exception.",
        ),
      );
    }

    for (const shape of slide.shapes ?? []) {
      const p = shape.position;
      if (p.left < 0 || p.top < 0 || p.left + p.width > plan.canvas.width || p.top + p.height > plan.canvas.height) {
        diagnostics.push(
          diagnostic("SW001", "error", slide.id, shape.id, "Object extends outside the slide canvas.", "Move or resize the object inside the canvas."),
        );
      }
      if (shape.editable !== true) {
        diagnostics.push(
          diagnostic("SW005", "error", slide.id, shape.id, "Object is not marked editable.", "Render semantic content as a native PowerPoint object."),
        );
      }
      if (shape.padding) {
        const values = Object.values(shape.padding);
        if (!values.every((value) => nearlyEqual(value, values[0], tolerance))) {
          diagnostics.push(
            diagnostic("SW007", "error", slide.id, shape.id, `Component padding is asymmetric: ${JSON.stringify(shape.padding)}.`, "Use uniform padding or declare an intentional exception."),
          );
        }
      }
      if (shape.type !== "text") continue;

      const size = shape.style?.fontSizePt;
      if (!Number.isInteger(size)) {
        diagnostics.push(
          diagnostic("SW003", "error", slide.id, shape.id, `Font size ${size}pt is fractional.`, "Select a whole point value from the approved scale."),
        );
      } else if (!approved.has(size)) {
        diagnostics.push(
          diagnostic("SW002", "error", slide.id, shape.id, `Font size ${size}pt is outside the approved scale.`, "Select the closest approved size that fits."),
        );
      }
      if (Number.isFinite(shape.fit?.minSizePt) && size < shape.fit.minSizePt) {
        diagnostics.push(
          diagnostic("SW009", "error", slide.id, shape.id, `Font size ${size}pt is below the configured ${shape.fit.minSizePt}pt minimum.`, "Shorten the copy or choose a less dense layout; never bypass the minimum type size."),
        );
      }
      if (!shape.fit?.fits) {
        diagnostics.push(
          diagnostic("SW004", "error", slide.id, shape.id, "Text does not fit at the configured minimum size.", "Shorten the copy, enlarge the frame, or select a less dense layout."),
        );
      }
      if (!shape.text?.runs?.length || textFromRuns(shape.text.runs).trim() === "") {
        diagnostics.push(
          diagnostic("SW008", "error", slide.id, shape.id, "Text object is empty.", "Remove the object or provide audience-facing copy."),
        );
      }
    }
  }

  const counts = diagnostics.reduce(
    (acc, item) => ({ ...acc, [item.severity]: (acc[item.severity] ?? 0) + 1 }),
    { error: 0, warning: 0 },
  );
  return {
    valid: diagnostics.length === 0,
    counts,
    diagnostics,
    planHash: plan.build?.deterministicHash ?? null,
  };
}
