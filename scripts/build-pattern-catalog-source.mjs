#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const families = [
  {
    id: "executive-synthesis",
    label: "Executive synthesis",
    names: [
      "Single answer with three proofs",
      "Recommendation rationale and impact",
      "Decision ask trade-offs and next move",
      "Situation complication resolution",
      "Case-for-change burning platform",
      "Where-to-play and how-to-win",
      "CEO four-priority scorecard",
      "Executive narrative ribbon",
      "One metric one implication one action",
      "So-what portfolio snapshot",
    ],
    purposes: ["synthesize", "recommend", "decide"],
    relationships: ["evidence", "implication", "priority"],
    engines: ["point-grid", "two-column", "hero", "point-grid", "opposition", "two-column", "quadrant-focus", "chevron-flow", "hero", "point-grid"],
    counts: [[3, 3], [2, 2], [3, 3], [3, 3], [2, 2], [2, 2], [4, 4], [3, 5], [3, 3], [4, 6]],
  },
  {
    id: "comparisons-choices",
    label: "Comparisons and choices",
    names: [
      "Pro-con with asymmetric recommendation",
      "Before-after mirror",
      "Current-target operating model",
      "Three-option weighted decision",
      "Two-feature mirrored towers",
      "Cost-value trade-off",
      "Risk-reward quadrant",
      "Competitor benchmark",
      "Make-buy-partner",
      "Scenario comparison",
      "Base-upside-downside",
      "Objection evidence rebuttal",
    ],
    purposes: ["compare", "choose", "challenge"],
    relationships: ["opposition", "trade-off", "selection"],
    engines: ["opposition", "two-column", "two-column", "table", "opposition", "opposition", "quadrant-focus", "table", "point-grid", "table", "point-grid", "chevron-flow"],
    counts: [[2, 2], [2, 2], [2, 2], [3, 3], [2, 2], [2, 2], [4, 4], [3, 6], [3, 3], [3, 4], [3, 3], [3, 3]],
  },
  {
    id: "process-transformation",
    label: "Processes and transformation",
    names: [
      "Three-step chevrons",
      "Five-step staircase",
      "Seven-step phased horizon",
      "Eight-stage arc",
      "Twelve-stage numbered cycle",
      "Stage-gate process",
      "Functional swimlanes",
      "Parallel workstreams converging",
      "Branch-to-convergence tree",
      "Double-diamond discovery and delivery",
      "Funnel-to-focused-action",
      "Hourglass diagnose decide scale",
      "Flywheel",
      "Closed feedback loop",
      "Input-engine-output",
      "Ownership handoff chain",
    ],
    purposes: ["sequence", "transform", "execute"],
    relationships: ["sequence", "dependency", "feedback"],
    engines: ["chevron-flow", "chevron-flow", "point-grid", "polygon-cycle", "polygon-cycle", "chevron-flow", "table", "icon-network", "icon-network", "opposition", "point-grid", "opposition", "polygon-cycle", "polygon-cycle", "chevron-flow", "chevron-flow"],
    counts: [[3, 3], [5, 5], [7, 7], [8, 8], [12, 12], [3, 5], [3, 6], [3, 5], [3, 6], [4, 4], [3, 5], [3, 3], [4, 8], [4, 8], [3, 3], [3, 5]],
  },
  {
    id: "shape-relationship-systems",
    label: "Shape and relationship systems",
    names: [
      "Two-pole tension axis",
      "Three-discipline triangle",
      "Four-part square in circle",
      "Central diamond with four quadrants",
      "Five-capability pentagon",
      "Six-node hexagonal hub",
      "Seven-element heptagonal system",
      "Eight-element octagonal system",
      "Nine-part three-by-three architecture",
      "Ten-node concentric system",
      "Twelve-node perimeter network",
      "Layered capability house",
    ],
    purposes: ["model", "organize", "explain-system"],
    relationships: ["system", "hierarchy", "mutual-reinforcement"],
    engines: ["opposition", "polygon-cycle", "polygon-cycle", "quadrant-focus", "polygon-cycle", "icon-network", "polygon-cycle", "polygon-cycle", "point-grid", "polygon-cycle", "polygon-cycle", "point-grid"],
    counts: [[2, 2], [3, 3], [4, 4], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [12, 12], [3, 5]],
  },
  {
    id: "quantitative-exhibits",
    label: "Quantitative exhibits",
    names: [
      "Direct-label bar chart",
      "Diverging variance bars",
      "Stacked contribution to total",
      "Waterfall value bridge",
      "Slopegraph",
      "Dumbbell comparison",
      "Ranked dot plot",
      "Bullet chart",
      "Inflection-point line chart",
      "Indexed trend comparison",
      "Small-multiple trends",
      "Scatterplot with strategic zones",
      "Bubble portfolio",
      "Metric heatmap",
      "Cohort matrix",
      "Tornado sensitivity",
      "Driver contribution bridge",
      "Marimekko share-shift exhibit",
    ],
    purposes: ["quantify", "diagnose", "prove"],
    relationships: ["comparison", "change", "distribution"],
    engines: ["table", "table", "table", "table", "two-column", "two-column", "table", "table", "table", "table", "point-grid", "quadrant-focus", "quadrant-focus", "table", "table", "two-column", "chevron-flow", "table"],
    counts: [[3, 6], [3, 6], [3, 6], [4, 7], [2, 2], [2, 2], [4, 8], [3, 6], [4, 8], [3, 6], [6, 9], [4, 4], [4, 4], [4, 8], [4, 8], [2, 2], [3, 5], [3, 6]],
  },
  {
    id: "tables-scorecards",
    label: "Tables and scorecards",
    names: [
      "KPI strip with detail table",
      "Strategic balanced scorecard",
      "Maturity heatmap",
      "Issue evidence implication table",
      "Initiative prioritization matrix",
      "Risk register",
      "Benchmark league table",
      "RACI and workplan",
      "Financial business case",
      "Decision log",
    ],
    purposes: ["track", "prioritize", "govern"],
    relationships: ["evaluation", "ownership", "status"],
    engines: ["table", "quadrant-focus", "table", "table", "table", "table", "table", "table", "table", "table"],
    counts: [[3, 6], [4, 4], [4, 8], [3, 6], [3, 6], [3, 8], [4, 8], [3, 8], [3, 6], [3, 8]],
  },
  {
    id: "timelines-roadmaps",
    label: "Timelines and roadmaps",
    names: [
      "Milestone timeline",
      "Phased roadmap",
      "Now-next-later",
      "One-hundred-day plan",
      "Workstream roadmap",
      "Critical-path plan",
      "Horizon one two three roadmap",
      "Release train",
      "Transformation waves",
      "Dependency map",
    ],
    purposes: ["plan", "sequence", "mobilize"],
    relationships: ["time", "dependency", "milestone"],
    engines: ["chevron-flow", "chevron-flow", "chevron-flow", "point-grid", "table", "icon-network", "chevron-flow", "point-grid", "point-grid", "icon-network"],
    counts: [[3, 5], [3, 5], [3, 3], [4, 6], [3, 6], [3, 6], [3, 3], [4, 8], [3, 6], [3, 6]],
  },
  {
    id: "organization-ecosystems",
    label: "Organization and ecosystems",
    names: [
      "Value-chain architecture",
      "Operating-model layers",
      "Accountability and spans",
      "Ecosystem hub-and-spoke",
      "Customer journey",
      "Service blueprint",
    ],
    purposes: ["organize", "map", "design-operating-model"],
    relationships: ["flow", "ownership", "ecosystem"],
    engines: ["chevron-flow", "point-grid", "table", "icon-network", "chevron-flow", "table"],
    counts: [[3, 5], [3, 6], [3, 6], [4, 8], [3, 5], [3, 6]],
  },
  {
    id: "evidence-narrative",
    label: "Evidence and narrative",
    names: [
      "Challenge action impact case study",
      "Customer quote with quantified proof",
      "Annotated exhibit spotlight",
      "Voice-of-customer theme synthesis",
      "One critical risk with mitigation",
      "Closing recommendation decision owner date",
    ],
    purposes: ["tell-story", "prove", "close"],
    relationships: ["narrative", "evidence", "action"],
    engines: ["chevron-flow", "hero", "two-column", "point-grid", "opposition", "hero"],
    counts: [[3, 3], [2, 2], [2, 2], [3, 6], [2, 2], [3, 3]],
  },
];

const engineProfiles = {
  hero: { density: "sparse", sequence: false, overlap: false, hierarchy: "strong", dataMode: "narrative" },
  "two-column": { density: "standard", sequence: false, overlap: false, hierarchy: "balanced", dataMode: "qualitative" },
  table: { density: "dense", sequence: false, overlap: false, hierarchy: "tabular", dataMode: "quantitative" },
  "point-grid": { density: "standard", sequence: false, overlap: false, hierarchy: "peer", dataMode: "mixed" },
  "polygon-cycle": { density: "standard", sequence: true, overlap: false, hierarchy: "system", dataMode: "qualitative" },
  opposition: { density: "standard", sequence: false, overlap: false, hierarchy: "tension", dataMode: "mixed" },
  "quadrant-focus": { density: "standard", sequence: false, overlap: true, hierarchy: "focus", dataMode: "mixed" },
  "chevron-flow": { density: "standard", sequence: true, overlap: false, hierarchy: "progression", dataMode: "qualitative" },
  "icon-network": { density: "standard", sequence: false, overlap: true, hierarchy: "network", dataMode: "qualitative" },
};

const firmResearch = ["McKinsey", "BCG", "Bain", "Oliver Wyman", "Strategy&", "Roland Berger"];
const reviewedPass = new Set([39, 43, 45, 46, 49]);
const reviewedRevise = new Set([2, 8, 23, 26, 27, 37, 47, 72, 81, 84, 85, 88, 89, 93, 95, 100]);
const reviewScores = new Map([
  [2, 78], [8, 84], [23, 86], [26, 88], [27, 90], [37, 89], [39, 94], [43, 93], [45, 94], [46, 94], [47, 87], [49, 94],
  [72, 72], [81, 76], [84, 72], [85, 75], [88, 80], [89, 78], [93, 73], [95, 72], [100, 76],
]);

function requiredSemanticMarks(ordinal, name, family) {
  if ([40, 41, 43, 45, 46, 48, 49].includes(ordinal)) return ["regular-polygon", "central-outcome", "external-callouts", "single-focus"];
  if (ordinal === 39) return ["opposed-fields", "matched-dimensions", "synthesis-band"];
  if (ordinal === 42) return ["four-zones", "central-diamond", "semantic-icons"];
  if (ordinal === 44) return ["hexagonal-hub", "radial-adjacency", "semantic-icons"];
  if (ordinal === 47) return ["three-by-three-grid", "single-focus", "peer-cards"];
  if (ordinal === 50) return ["capability-house", "layered-foundation", "outcome-roof"];
  if (ordinal >= 51 && ordinal <= 68) {
    const quantitative = [
      ["axis", "bars", "direct-labels"], ["zero-axis", "diverging-bars", "variance-labels"], ["stacked-bars", "total-scale", "segment-labels"],
      ["waterfall-bars", "bridge-connectors", "start-end-totals"], ["paired-endpoints", "slopes", "direct-labels"], ["paired-dots", "connecting-lines", "common-scale"],
      ["ranked-dots", "common-scale", "direct-labels"], ["measure-bar", "target-marker", "performance-bands"], ["trend-line", "inflection-marker", "time-axis"],
      ["indexed-lines", "baseline", "time-axis"], ["small-multiple-plots", "common-scale", "exception-focus"], ["x-y-axes", "data-points", "strategic-zones"],
      ["x-y-axes", "scaled-bubbles", "portfolio-zones"], ["matrix-cells", "heat-scale", "legend"], ["cohort-grid", "time-diagonals", "retention-scale"],
      ["center-axis", "ranked-variance-bars", "sensitivity-labels"], ["bridge-bars", "positive-negative-drivers", "end-total"], ["variable-width-columns", "stacked-shares", "segment-focus"],
    ];
    return quantitative[ordinal - 51];
  }
  if (ordinal >= 69 && ordinal <= 78) return ["domain-specific-columns", "evidence-values", "decision-focus"];
  if (ordinal >= 79 && ordinal <= 88) return ["time-axis", "milestones", "direction", "owned-outcomes"];
  if (ordinal === 92) return ["central-hub", "radial-spokes", "ecosystem-nodes"];
  if ([93, 94].includes(ordinal)) return ["journey-stages", "parallel-lanes", "handoffs"];
  if (family === "process-transformation" || family === "timelines-roadmaps") return ["sequential-stages", "direction", "owned-outcomes"];
  if (family === "comparisons-choices") return ["matched-dimensions", "decision-criteria", "recommendation"];
  if (family === "executive-synthesis") return ["answer-first", "supporting-proof", "owned-implication"];
  if (family === "organization-ecosystems") return ["named-roles", "relationship-structure", "owned-implication"];
  return ["narrative-evidence", "owned-implication", "single-focus"];
}

const patterns = [];
let globalIndex = 0;
for (const family of families) {
  family.names.forEach((name, localIndex) => {
    globalIndex += 1;
    const archetype = family.engines[localIndex];
    const profile = engineProfiles[archetype];
    const [minimum, maximum] = family.counts[localIndex];
    const styleClass = globalIndex <= 60 ? "classic-analytical" : globalIndex <= 90 ? "contemporary-geometric" : "bold-narrative";
    const id = `c${String(globalIndex).padStart(3, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const reviewStatus = reviewedPass.has(globalIndex) ? "pass" : reviewedRevise.has(globalIndex) ? "revise" : "veto";
    patterns.push({
      id,
      ordinal: globalIndex,
      name,
      family: family.id,
      familyLabel: family.label,
      archetype,
      implementationLevel: reviewStatus === "pass" ? "reviewed-release-candidate" : reviewStatus === "revise" ? "engine-backed-recipe" : "structural-blueprint",
      selector: {
        purposes: family.purposes,
        relationships: family.relationships,
        itemCountRange: { minimum, maximum },
        density: profile.density,
        sequence: profile.sequence,
        overlap: profile.overlap,
        hierarchy: profile.hierarchy,
        dataMode: profile.dataMode,
      },
      variantParams: {
        arrangement: archetype === "point-grid" ? (maximum > 6 ? "auto" : ["auto", "columns", "rows", "grid"][localIndex % 4]) : null,
        relationship: archetype === "polygon-cycle" ? ["cycle", "system", "perimeter", "mutual-reinforcement"][localIndex % 4] : null,
        emphasisIndex: maximum > 2 ? localIndex % maximum : null,
      },
      slotContract: {
        title: { required: true, maximumWords: 18, role: "action-title" },
        items: { required: !["hero", "two-column", "opposition"].includes(archetype), minimum, maximum },
        richText: { preserveRunLevelEmphasis: true, preferredDelimiter: " - " },
      },
      designContract: {
        intent: `Use ${name.toLowerCase()} when the argument is best understood as ${family.relationships.join(", ")}.`,
        argumentSchema: family.purposes.join(" -> "),
        supportedItemCounts: [minimum, maximum],
        layoutFamily: family.id,
        gridAndSafeZones: "64px outer rim; 24px gutters; symmetric component padding; full-width title unless the composition declares a real split.",
        textRoles: ["action-title", "component-heading", "component-body", "source"],
        focusRule: "One primary focal point; change no more than two emphasis variables.",
        connectorPolicy: "Prefer adjacency; otherwise route behind nodes, terminate under the rim, and match the receiving rim token.",
        geometryConstraints: "Comparable objects share dimensions; circles remain circular; regular polygons use one circumradius and equal angles.",
        contentBudget: { titleWords: 18, itemHeadingWords: 5, itemBodyWords: profile.density === "dense" ? 16 : 22 },
        nativeEditabilityContract: "All visible text, shapes, tables, icons, and connectors remain native editable PowerPoint objects.",
        overflowFallback: "Shorten, move explanation outside the geometry, change arrangement, or split the slide before reducing type below the minimum.",
        antiUseCases: ["ornamental geometry", "multiple competing highlights", "paragraphs inside narrow shapes", "rasterized text"],
        renderTests: ["no-overlap", "no-spill", "symmetric-padding", "integer-font-sizes", "full-size-review"],
        ooxmlTests: ["native-text", "run-level-emphasis", "editable-objects", "save-reopen-stability"],
      },
      semanticSignature: {
        requiredMarks: requiredSemanticMarks(globalIndex, name, family.id),
        fallbackForbidden: true,
      },
      visualReview: {
        status: reviewStatus,
        score: reviewScores.get(globalIndex) ?? null,
        threshold: 92,
        reviewedAtFullSize: true,
        note: reviewStatus === "pass"
          ? "Independent full-size review found no critical defect in the rendered structural example."
          : "The current engine-backed example is not release-ready for this named pattern; rebuild its defining semantic marks before use.",
      },
      styleClass,
      qualityTags: ["answer-first", "native-editable", "single-focus", "partner-reviewable"],
      provenance: {
        kind: "original-structural-synthesis",
        researchSet: firmResearch,
        note: "Inspired by recurring public consulting information architectures; no firm artwork, templates, or brand system copied.",
      },
    });
  });
}

if (patterns.length !== 100) throw new Error(`Expected 100 patterns, found ${patterns.length}.`);

const catalog = {
  schemaVersion: "slidewright-pattern-catalog/v1",
  catalogVersion: "1.0.0",
  title: "Slidewright consulting pattern catalog",
  portfolioPolicy: {
    classicAnalytical: 60,
    contemporaryGeometric: 30,
    boldNarrative: 10,
    principle: "Innovation comes from sharper visual logic, not ornamental geometry.",
  },
  patterns,
};

const target = path.resolve("plugins/slidewright/skills/slidewright/assets/pattern-catalog/v1/catalog.json");
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${patterns.length} patterns to ${target}\n`);
