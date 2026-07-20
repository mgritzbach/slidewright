export const DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720 });

export const COMMON_FONT_SIZES_PT = Object.freeze([
  54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12,
]);

export const DEFAULT_THEME = Object.freeze({
  fontFamily: "Arial",
  fallbackFontFamily: "Arial",
  colors: {
    background: "#F8FAFC",
    surface: "#FFFFFF",
    text: "#0F172A",
    muted: "#475569",
    subtle: "#94A3B8",
    accent: "#4F46E5",
    accentSoft: "#E0E7FF",
    border: "#CBD5E1",
    success: "#047857",
  },
});

export const DEFAULT_LAYOUT = Object.freeze({
  margin: 64,
  componentPadding: 32,
  gutter: 24,
  columns: 12,
  geometryTolerance: 1,
});

// Insets use canvas pixels because the deterministic layout plan is pixel based.
// Paragraph spacing uses PowerPoint points and is kept separate deliberately.
export const DEFAULT_INSET_TOKENS_PX = Object.freeze([0, 8, 12, 16, 24, 32]);
export const DEFAULT_MAX_INSET_PX = 32;
export const DEFAULT_PARAGRAPH_SPACING_PT = Object.freeze([0, 6, 12]);

export const DEFAULT_TYPOGRAPHY_ROLES = Object.freeze({
  eyebrow: Object.freeze({ preferredSizePt: 14, minimumSizePt: 12, maximumLines: 1, lineHeight: 1, baseWeight: "bold" }),
  "hero-title": Object.freeze({ preferredSizePt: 54, minimumSizePt: 28, maximumLines: 2, lineHeight: 1.02, baseWeight: "flexible" }),
  "slide-title": Object.freeze({ preferredSizePt: 36, minimumSizePt: 28, maximumLines: 2, lineHeight: 1.02, baseWeight: "flexible" }),
  "section-title": Object.freeze({ preferredSizePt: 44, minimumSizePt: 28, maximumLines: 3, lineHeight: 1.02, baseWeight: "flexible" }),
  subtitle: Object.freeze({ preferredSizePt: 24, minimumSizePt: 16, maximumLines: 4, lineHeight: 1.2, baseWeight: "flexible" }),
  body: Object.freeze({ preferredSizePt: 24, minimumSizePt: 16, maximumLines: 14, lineHeight: 1.2, baseWeight: "flexible" }),
  "component-heading": Object.freeze({ preferredSizePt: 20, minimumSizePt: 16, maximumLines: 2, lineHeight: 1, baseWeight: "bold" }),
  "component-body": Object.freeze({ preferredSizePt: 24, minimumSizePt: 16, maximumLines: 8, lineHeight: 1.22, baseWeight: "flexible" }),
  "table-header": Object.freeze({ preferredSizePt: 16, minimumSizePt: 14, maximumLines: 2, lineHeight: 1.08, baseWeight: "bold" }),
  "table-body": Object.freeze({ preferredSizePt: 16, minimumSizePt: 14, maximumLines: 3, lineHeight: 1.12, baseWeight: "regular-with-emphasis" }),
  icon: Object.freeze({ preferredSizePt: 28, minimumSizePt: 20, maximumLines: 1, lineHeight: 1, baseWeight: "regular" }),
  "chart-label": Object.freeze({ preferredSizePt: 12, minimumSizePt: 12, maximumLines: 1, lineHeight: 1, baseWeight: "regular" }),
  callout: Object.freeze({ preferredSizePt: 24, minimumSizePt: 16, maximumLines: 2, lineHeight: 1.08, baseWeight: "bold" }),
});

export const DEFAULT_ARCHETYPES = Object.freeze({
  hero: Object.freeze({ pageRole: "narrative", requiredStyleRoles: Object.freeze(["eyebrow", "hero-title", "body", "callout"]), requiredBackedRoles: Object.freeze({ callout: 1 }) }),
  "two-column": Object.freeze({
    pageRole: "comparison",
    requiredStyleRoles: Object.freeze(["slide-title", "component-heading", "component-body"]),
    requiredBackedRoles: Object.freeze({ subheading: 2, body: 2 }),
    componentFamilies: Object.freeze({ "two-column-card": Object.freeze({ minimumInstances: 2, requiredSlots: Object.freeze(["heading", "body"]), allowedVariants: Object.freeze(["neutral", "accent"]) }) }),
  }),
  section: Object.freeze({ pageRole: "section-divider", requiredStyleRoles: Object.freeze(["section-title", "subtitle"]), requiredBackedRoles: Object.freeze({ title: 1 }) }),
  continuation: Object.freeze({ pageRole: "continuation", requiredStyleRoles: Object.freeze(["eyebrow", "slide-title", "body"]), requiredBackedRoles: Object.freeze({ body: 1 }) }),
  table: Object.freeze({ pageRole: "structured-data", requiredStyleRoles: Object.freeze(["slide-title", "table-header", "table-body"]) }),
  "icon-list": Object.freeze({
    pageRole: "semantic-overview",
    requiredStyleRoles: Object.freeze(["slide-title", "icon", "component-heading", "component-body"]),
    requiredBackedRoles: Object.freeze({ icon: 2, subheading: 2, body: 2 }),
    componentFamilies: Object.freeze({ "semantic-card": Object.freeze({ minimumInstances: 2, requiredSlots: Object.freeze(["heading", "body"]), allowedVariants: Object.freeze(["default"]) }) }),
    requiresSemanticIcons: true,
    minimumSemanticIcons: 2,
  }),
  "point-grid": Object.freeze({
    pageRole: "structured-argument",
    requiredStyleRoles: Object.freeze(["slide-title", "component-heading", "component-body"]),
    requiredBackedRoles: Object.freeze({ subheading: 2, body: 2 }),
    componentFamilies: Object.freeze({ "point-cell": Object.freeze({ minimumInstances: 2, requiredSlots: Object.freeze(["heading", "body"]), allowedVariants: Object.freeze(["default", "emphasis"]) }) }),
  }),
  "polygon-cycle": Object.freeze({
    pageRole: "system-relationship",
    requiredStyleRoles: Object.freeze(["slide-title", "component-heading", "component-body"]),
    requiredBackedRoles: Object.freeze({ subheading: 3, body: 3 }),
    componentFamilies: Object.freeze({ "polygon-node": Object.freeze({ minimumInstances: 3, requiredSlots: Object.freeze(["heading", "body"]), allowedVariants: Object.freeze(["default", "emphasis"]) }) }),
  }),
  opposition: Object.freeze({
    pageRole: "opposition",
    requiredStyleRoles: Object.freeze(["slide-title", "component-heading", "component-body"]),
    requiredBackedRoles: Object.freeze({ subheading: 2, body: 2 }),
    componentFamilies: Object.freeze({ "opposition-side": Object.freeze({ minimumInstances: 2, requiredSlots: Object.freeze(["heading", "body"]), allowedVariants: Object.freeze(["left", "right"]) }) }),
  }),
});

export const DEFAULT_ICON_ONTOLOGY = Object.freeze({
  goal: Object.freeze({ icons: Object.freeze(["target", "bullseye"]) }),
  context: Object.freeze({ icons: Object.freeze(["globe", "context-ring"]) }),
  constraints: Object.freeze({ icons: Object.freeze(["guardrail", "shield"]) }),
  completion: Object.freeze({ icons: Object.freeze(["check", "code"]) }),
});

export const DEFAULT_ICON_GLYPHS = Object.freeze({
  target: "◎",
  bullseye: "◎",
  globe: "⊕",
  "context-ring": "⊕",
  guardrail: "[ ]",
  shield: "◇",
  check: "✓",
  code: "</>",
});

export function mergeTheme(theme = {}) {
  return {
    ...DEFAULT_THEME,
    ...theme,
    colors: { ...DEFAULT_THEME.colors, ...(theme.colors ?? {}) },
  };
}
