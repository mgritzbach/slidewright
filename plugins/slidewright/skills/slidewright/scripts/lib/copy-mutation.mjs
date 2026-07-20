const EXPANSION_WORDS = ["editable", "verified", "formatting", "proof"];

export function mutateString(value, factor) {
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const words = value.trim().split(/\s+/u);
  const target = Math.max(1, Math.round(words.length * factor));
  if (target <= words.length) return `${leading}${words.slice(0, target).join(" ")}${trailing}`;
  const expanded = [...words];
  while (expanded.length < target) expanded.push(EXPANSION_WORDS[(expanded.length - words.length) % EXPANSION_WORDS.length]);
  return `${leading}${expanded.join(" ")}${trailing}`;
}

function mutateText(value, factor) {
  if (typeof value === "string") return mutateString(value, factor);
  if (value?.runs) {
    return { ...value, runs: value.runs.map((run) => ({ ...run, text: mutateString(run.text, factor) })) };
  }
  return value;
}

export function mutateDeckCopy(input, factor) {
  const spec = structuredClone(input);
  for (const slide of spec.slides) {
    for (const key of ["eyebrow", "title", "body", "callout"]) {
      if (slide[key] != null) slide[key] = mutateText(slide[key], factor);
    }
    for (const side of ["left", "right"]) {
      if (!slide[side]) continue;
      slide[side].heading = mutateText(slide[side].heading, factor);
      slide[side].body = mutateText(slide[side].body, factor);
    }
    for (const item of slide.items ?? []) {
      item.label = mutateText(item.label, factor);
      item.body = mutateText(item.body, factor);
    }
    if (slide.synthesis != null) slide.synthesis = mutateText(slide.synthesis, factor);
  }
  spec.title = `${spec.title} copy-${Math.round(factor * 100)}`;
  return spec;
}

export function mutateFlexibleDeckCopy(input, factor) {
  const spec = structuredClone(input);
  for (const slide of spec.slides) {
    if (slide.layout === "hero") {
      slide.body = mutateText(slide.body, factor);
      slide.callout = mutateText(slide.callout, factor);
    } else if (slide.layout === "two-column") {
      slide.left.body = mutateText(slide.left.body, factor);
      slide.right.body = mutateText(slide.right.body, factor);
    } else if (slide.layout === "section") {
      slide.subtitle = mutateText(slide.subtitle, factor);
    } else if (slide.layout === "continuation") {
      slide.body = mutateText(slide.body, factor);
    } else if (slide.layout === "point-grid") {
      for (const item of slide.items ?? []) item.body = mutateText(item.body, factor);
    } else if (slide.layout === "opposition") {
      slide.left.body = mutateText(slide.left.body, factor);
      slide.right.body = mutateText(slide.right.body, factor);
      if (slide.synthesis != null) slide.synthesis = mutateText(slide.synthesis, factor);
    }
  }
  spec.title = `${spec.title} flexible-copy-${Math.round(factor * 100)}`;
  return spec;
}
