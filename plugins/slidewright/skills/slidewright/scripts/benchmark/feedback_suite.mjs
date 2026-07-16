import { compileDeck } from "../lib/compiler.mjs";

function paragraphBody(index) {
  const paragraphs = [
    { bullet: true, runs: [{ text: `Core explanation ${index + 1} remains native and editable.` }] },
    { bullet: true, runs: [{ text: "   " }] },
    { bullet: true, level: 1, runs: [{ text: "The supporting detail keeps its hierarchy without a blank bullet." }] },
    { bullet: true, runs: [{ text: "" }] },
    { bullet: true, runs: [{ text: "A verification step makes the outcome inspectable." }] },
  ];
  return { paragraphs };
}

export function buildFeedbackSpec(manifest) {
  const slides = [];
  manifest.topics.forEach((topic, index) => {
    slides.push({
      id: `${topic.id}-divider`,
      layout: "section",
      topicId: topic.id,
      coverageRole: "divider",
      title: topic.title,
      subtitle: `Topic ${index + 1} of ${manifest.topicCount}. This explicit divider proves that no declared chapter is compressed away.`,
    });
    if (index % 2 === 0) {
      slides.push({
        id: `${topic.id}-content`,
        layout: "hero",
        topicId: topic.id,
        coverageRole: "substantive",
        ...(index === 2 ? { headlineSplit: { ratio: "two-thirds", side: "left" } } : {}),
        eyebrow: `Topic ${String(index + 1).padStart(2, "0")}`,
        title: `A substantive, editable explanation of ${topic.title.replace(/\?$/u, "")}`,
        body: index === 0 ? paragraphBody(index) : `This teaching slide gives ${topic.title.toLowerCase()} its own audience-facing explanation instead of only mentioning it inside another chapter.`,
        callout: "The compiler must preserve safe width, fit, spacing, and editability before this slide can ship.",
      });
    } else {
      slides.push({
        id: `${topic.id}-content`,
        layout: "two-column",
        topicId: topic.id,
        coverageRole: "substantive",
        ...(index === 1 ? { headlineSplit: { ratio: "center", side: "left" } } : {}),
        title: `Understand and apply ${topic.title.replace(/\?$/u, "")}`,
        left: { heading: "Understand", body: `Explain the central idea behind ${topic.title.toLowerCase()} in concise, audience-ready language.` },
        right: { heading: "Apply", body: "Show one concrete action, one verification step, and one editable outcome." },
      });
    }
  });
  return {
    version: "0.1",
    title: "Slidewright Locate event feedback benchmark",
    theme: { fontFamily: "Arial", colors: { accent: "#4F46E5", accentSoft: "#E0E7FF" } },
    coverage: { topics: manifest.topics },
    slides,
  };
}

function onlyRule(plan, ruleId) {
  return { plan, expectedRuleId: ruleId };
}

export function buildFeedbackPlanMutants(manifest) {
  const build = () => compileDeck(buildFeedbackSpec(manifest));
  const mutants = [];

  {
    const plan = build();
    const slide = plan.slides[1];
    const title = slide.shapes.find((shape) => shape.role === "title");
    const body = slide.shapes.find((shape) => shape.role === "body");
    body.position.top = title.position.top + title.position.height - 0.25;
    body.constraints = { allowOverlapWith: [title.id] };
    mutants.push({ id: "waived-text-overlap", ...onlyRule(plan, "SW018") });
  }
  {
    const plan = build();
    const slide = plan.slides[1];
    const body = slide.shapes.find((shape) => shape.role === "body");
    const reserved = {
      id: "reserved-source-screenshot", type: "shape", role: "reserved-region", geometry: "rect",
      position: { ...body.position }, fill: "#CBD5E1", line: { color: "#CBD5E1", width: 0 }, editable: true,
    };
    slide.shapes.unshift(reserved);
    slide.layoutContract.reservedRegionIds.push(reserved.id);
    body.constraints = { allowOverlapWith: [reserved.id] };
    mutants.push({ id: "text-in-reserved-region", ...onlyRule(plan, "SW018") });
  }
  {
    const plan = build();
    plan.slides[1].shapes.find((shape) => shape.role === "title").position.width -= 1;
    mutants.push({ id: "shortened-headline", ...onlyRule(plan, "SW019") });
  }
  {
    const plan = build();
    plan.slides[0].shapes.find((shape) => shape.role === "text-backing").position.height -= 1;
    mutants.push({ id: "undersized-title-backing", ...onlyRule(plan, "SW020") });
  }
  {
    const plan = build();
    plan.slides = plan.slides.filter((slide) => slide.id !== `${manifest.topics[3].id}-divider`);
    mutants.push({ id: "missing-topic-divider", ...onlyRule(plan, "SW021") });
  }
  {
    const plan = build();
    plan.slides = plan.slides.filter((slide) => slide.id !== `${manifest.topics[4].id}-content`);
    mutants.push({ id: "missing-topic-content", ...onlyRule(plan, "SW021") });
  }
  {
    const plan = build();
    [plan.slides[6], plan.slides[7]] = [plan.slides[7], plan.slides[6]];
    mutants.push({ id: "topic-order-inversion", ...onlyRule(plan, "SW021") });
  }
  {
    const plan = build();
    plan.slides.find((slide) => slide.id === `${manifest.topics[5].id}-content`).topicId = manifest.topics[4].id;
    mutants.push({ id: "merged-topic-ownership", ...onlyRule(plan, "SW021") });
  }
  {
    const plan = build();
    const body = plan.slides[1].shapes.find((shape) => shape.role === "body");
    body.text.paragraphs.splice(1, 0, { bullet: true, level: 0, runs: [{ text: "  ", bold: false }] });
    mutants.push({ id: "reinserted-empty-paragraph", ...onlyRule(plan, "SW022") });
  }
  return mutants;
}
