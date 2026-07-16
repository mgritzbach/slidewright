const EPSILON = 1e-9;

export function shapeRect(shape) {
  const { left, top, width, height } = shape.position;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

export function positiveIntersection(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > EPSILON && height > EPSILON ? { width, height, area: width * height } : null;
}

function innerRect(shape) {
  const outer = shapeRect(shape);
  const padding = shape.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    left: outer.left + Number(padding.left ?? 0),
    top: outer.top + Number(padding.top ?? 0),
    right: outer.right - Number(padding.right ?? 0),
    bottom: outer.bottom - Number(padding.bottom ?? 0),
  };
}

export function headlineSafeInterval(slide, shapesById) {
  const contract = slide.layoutContract?.headline;
  if (!contract) return null;
  const headline = shapesById.get(contract.shapeId);
  if (!headline) return { error: `Headline object '${contract.shapeId}' does not exist.` };
  const container = contract.containerId ? shapesById.get(contract.containerId) : null;
  if (contract.containerId && !container) return { error: `Headline container '${contract.containerId}' does not exist.` };
  const base = container
    ? innerRect(container)
    : { left: slide.frame.left, right: slide.frame.left + slide.frame.width, top: slide.frame.top, bottom: slide.frame.top + slide.frame.height };
  const headlineRect = shapeRect(headline);
  const active = (slide.layoutContract?.structuralSplits ?? []).filter((split) => {
    const divider = shapesById.get(split.shapeId);
    if (!divider) return false;
    const dividerRect = shapeRect(divider);
    const verticalIntersection = Math.min(headlineRect.bottom, dividerRect.bottom) - Math.max(headlineRect.top, dividerRect.top);
    return verticalIntersection > EPSILON && dividerRect.left > base.left && dividerRect.right < base.right;
  });
  if (!active.length) return { left: base.left, right: base.right, split: "none" };
  if (active.length !== 1) return { error: "A headline may intersect at most one declared structural split." };
  const split = active[0];
  const divider = shapesById.get(split.shapeId);
  const dividerRect = shapeRect(divider);
  const ratio = split.ratio === "center" ? 0.5 : split.ratio === "two-thirds" ? 2 / 3 : Number.NaN;
  const expectedX = base.left + (base.right - base.left) * ratio;
  if (!Number.isFinite(ratio) || Math.abs(dividerRect.left - expectedX) > 1e-6 || dividerRect.width > 2) {
    return { error: `Structural split '${split.shapeId}' is not on its declared ${split.ratio} line.` };
  }
  if (split.side === "left") return { left: base.left, right: dividerRect.left, split: split.ratio };
  if (split.side === "right") return { left: dividerRect.right, right: base.right, split: split.ratio };
  return { error: `Structural split '${split.shapeId}' must declare side 'left' or 'right'.` };
}

export function fitSurfaceExpectation(shapesById, contract) {
  const surface = shapesById.get(contract.surfaceId);
  if (!surface) return { error: `Fit surface '${contract.surfaceId}' does not exist.` };
  const children = (contract.childIds ?? []).map((id) => shapesById.get(id));
  if (!children.length || children.some((child) => !child)) return { error: `Fit surface '${contract.surfaceId}' has a missing child.` };
  const surfaceRect = shapeRect(surface);
  const padding = surface.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const requiredBottom = Math.max(...children.map((child) => shapeRect(child).bottom)) + Number(padding.bottom ?? 0);
  return {
    surface,
    children,
    expectedBottom: Math.max(surfaceRect.top + Number(contract.minHeight ?? 0), requiredBottom),
    actualBottom: surfaceRect.bottom,
    padding,
  };
}
