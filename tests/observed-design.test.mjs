import test from "node:test";
import assert from "node:assert/strict";
import { validateObservedDesign } from "../plugins/slidewright/skills/slidewright/scripts/lib/observed-design.mjs";

function fixture() {
  return {
    version: "0.1",
    input: { sha256: "a".repeat(64), widthPx: 1280, heightPx: 720 },
    canvas: { width: 1280, height: 720, background: "#FFFFFF" },
    palette: [],
    objects: [
      {
        id: "panel",
        type: "shape",
        bbox: { left: 0.1, top: 0.1, width: 0.8, height: 0.8, units: "normalized" },
        rotationDeg: 0,
        zIndex: 0,
        editable: true,
        shape: { geometry: "rect", fill: "#112233", line: { color: "none", width: 0 }, radiusPx: 0 },
        confidence: { geometry: 0.9, style: 0.8 },
      },
      {
        id: "title",
        type: "text",
        bbox: { left: 0.2, top: 0.2, width: 0.6, height: 0.2, units: "normalized" },
        rotationDeg: 0,
        zIndex: 1,
        editable: true,
        text: {
          value: "Native text",
          runs: [{ text: "Native ", bold: true }, { text: "text" }],
          alignment: "left",
          verticalAlignment: "top",
          fontFamilyGuess: "Arial",
          fontSizePtGuess: 24,
          color: "#FFFFFF",
          lineHeight: 1,
          insets: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        confidence: { text: 1, geometry: 0.9, style: 0.8 },
      },
    ],
    groups: [],
    uncertainties: [],
  };
}

test("accepts a deterministic editable observation record", () => {
  assert.equal(validateObservedDesign(fixture()).objects.length, 2);
});

test("rejects fractional type sizes", () => {
  const value = fixture();
  value.objects[1].text.fontSizePtGuess = 23.5;
  assert.throws(() => validateObservedDesign(value), /integer point size/u);
});

test("rejects objects outside the observed canvas", () => {
  const value = fixture();
  value.objects[0].bbox.left = 0.3;
  assert.throws(() => validateObservedDesign(value), /exceeds the canvas horizontally/u);
});

test("rejects ambiguous z-order", () => {
  const value = fixture();
  value.objects[1].zIndex = 0;
  assert.throws(() => validateObservedDesign(value), /zIndex values must be unique/u);
});
