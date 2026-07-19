import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { adaptDeckCopyToFit, auditAdaptedDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { applyNamedEdits } from "../plugins/slidewright/skills/slidewright/scripts/lib/named-edits.mjs";

const demo = JSON.parse(await fs.readFile(new URL("../examples/demo/deck-spec.json", import.meta.url), "utf8"));

function item(label, body, { bullet = false, italicLabel = false } = {}) {
  return {
    bullet,
    runs: [
      { text: `${label} —`, bold: true, italic: italicLabel },
      { text: ` ${body}`, bold: false, italic: false },
    ],
  };
}

function examplesSpec({ bullet = false, german = false } = {}) {
  const labels = german
    ? [
      ["Nachrichtenüberblick", "Erhalte jeden Morgen relevante Nachrichten"],
      ["Seitenaktualisierung", "Halte deine Website kontinuierlich aktuell"],
      ["Zielprüfung", "Erhalte stündliche Fortschrittsmeldungen"],
      ["Aufgabenliste", "Erstelle morgens eine Liste aus E-Mails und Kalendern"],
    ]
    : [
      ["News summary", "Receive relevant personalized news every morning"],
      ["Page update", "Keep your website continuously up to date"],
      ["Goal check", "Get hourly progress updates on long tasks"],
      ["To-do list", "Create a morning list from email, notes, and calendars"],
    ];
  const spec = structuredClone(demo);
  spec.version = "0.2";
  spec.slides = [{
    id: german ? "translated-examples" : bullet ? "bullet-examples" : "examples",
    layout: "continuation",
    eyebrow: german ? "ÜBERSETZTE BEISPIELE" : "EXAMPLES",
    title: german ? "Wiederholte Textmuster bleiben erhalten" : "Repeated text patterns remain intact",
    body: {
      paragraphs: [
        { runs: [{ text: german ? "BEISPIELE" : "EXAMPLES", bold: false, italic: true }] },
        ...labels.map(([label, body], index) => item(label, body, { bullet, italicLabel: index === 3 })),
      ],
    },
  }];
  return spec;
}

function sw030(plan) {
  return lintPlan(plan).diagnostics.filter((diagnostic) => diagnostic.ruleId === "SW030");
}

test("SW030 accepts a repeated bold-label/regular-body pattern for bullets and plain list paragraphs", () => {
  for (const bullet of [false, true]) {
    const plan = compileDeck(examplesSpec({ bullet }));
    const report = lintPlan(plan);
    assert.equal(report.valid, true, JSON.stringify(report.diagnostics, null, 2));
    const body = plan.slides[0].shapes.find((shape) => shape.role === "body");
    const itemParagraphs = body.text.paragraphs.slice(1);
    assert.ok(itemParagraphs.every((paragraph) => paragraph.runs[0].bold === true && paragraph.runs[1].bold === false));
    assert.equal(itemParagraphs.at(-1).runs[0].italic, true, "a deliberately italic label remains allowed");
    assert.equal(itemParagraphs.at(-1).runs[1].italic, false, "label italics may not leak into the explanation");
  }
});

test("SW030 recognizes colon-delimited peers without requiring whitespace before the colon", () => {
  const spec = examplesSpec();
  for (const paragraph of spec.slides[0].body.paragraphs.slice(1)) {
    paragraph.runs[0].text = paragraph.runs[0].text.replace(/ —$/u, ":");
  }
  const plan = compileDeck(spec);
  assert.equal(sw030(plan).length, 0);
  const leaked = plan.slides[0].shapes.find((shape) => shape.role === "body").text.paragraphs.at(-1);
  leaked.runs[1].bold = true;
  assert.equal(sw030(plan).length, 1);
});

test("SW030 rejects alternating whole-paragraph emphasis and a single leaked bullet body", () => {
  const plain = examplesSpec();
  const plainItems = plain.slides[0].body.paragraphs.slice(1);
  plainItems.forEach((paragraph, index) => {
    const text = paragraph.runs.map((run) => run.text).join("");
    paragraph.runs = [{ text, bold: index % 2 === 1, italic: false }];
  });
  assert.equal(sw030(compileDeck(plain)).length, 1);

  const bullets = examplesSpec({ bullet: true });
  const leaked = bullets.slides[0].body.paragraphs.at(-1);
  leaked.runs = [{ text: leaked.runs.map((run) => run.text).join(""), bold: true, italic: true }];
  assert.equal(sw030(compileDeck(bullets)).length, 1);
});

test("SW030 rejects label emphasis leaking into only the first word of an explanation", () => {
  const plan = compileDeck(examplesSpec());
  const paragraph = plan.slides[0].shapes.find((shape) => shape.role === "body").text.paragraphs.at(-1);
  const explanation = paragraph.runs[1].text;
  const firstBoundary = explanation.indexOf(" ", 1);
  paragraph.runs.splice(1, 1,
    { ...paragraph.runs[1], text: explanation.slice(0, firstBoundary), bold: true },
    { ...paragraph.runs[1], text: explanation.slice(firstBoundary), bold: false },
  );
  assert.equal(sw030(plan).length, 1);
});

test("translation and adaptive compilation preserve every label/body run boundary", () => {
  const translated = examplesSpec({ german: true });
  const result = adaptDeckCopyToFit(translated);
  assert.equal(auditAdaptedDeckCopy(translated, result.spec, result.manifest, result.plan).valid, true);
  assert.equal(sw030(result.plan).length, 0);
  const body = result.plan.slides[0].shapes.find((shape) => shape.role === "body");
  for (const paragraph of body.text.paragraphs.slice(1)) {
    assert.equal(paragraph.runs[0].bold, true);
    assert.equal(paragraph.runs[1].bold, false);
  }
});

test("a named formatting change cannot make one explanation inherit its label emphasis", () => {
  const plan = compileDeck(examplesSpec());
  const body = plan.slides[0].shapes.find((shape) => shape.role === "body");
  const firstExplanation = body.text.runs.findIndex((run) => run.text.includes("Receive relevant"));
  assert.ok(firstExplanation >= 0);
  assert.throws(
    () => applyNamedEdits(plan, [{ type: "bold", targetId: body.id, runIndex: firstExplanation, value: true }]),
    /SW030/u,
  );
});
