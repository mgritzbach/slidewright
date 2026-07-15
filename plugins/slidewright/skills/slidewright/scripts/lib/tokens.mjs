export const DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720 });

export const COMMON_FONT_SIZES_PT = Object.freeze([
  54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12,
]);

export const DEFAULT_THEME = Object.freeze({
  fontFamily: "Aptos",
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

export function mergeTheme(theme = {}) {
  return {
    ...DEFAULT_THEME,
    ...theme,
    colors: { ...DEFAULT_THEME.colors, ...(theme.colors ?? {}) },
  };
}
