import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileDeck, validateDeckSpec } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { adaptDeckCopyToFit, auditAdaptedDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const fixture = JSON.parse(await readFile(new URL("../examples/consulting-layouts/deck-spec.json", import.meta.url), "utf8"));

test("count-aware consulting layouts compile and lint for every point count from 2 through 9", () => {
  const plan = compileDeck(fixture);
  const grids = plan.slides.filter((slide) => slide.layout === "point-grid");
  assert.deepEqual(grids.map((slide) => slide.layoutContract.peerGroups[0].memberIds.length), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(grids.map((slide) => slide.layoutContract.peerGroups[0].rows), [[2], [3], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [3, 3, 3]]);
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
});

test("point-grid rejects unsupported counts, duplicate ids, and multiple accidental emphases", () => {
  const tooMany = structuredClone(fixture.slides[0]);
  tooMany.items = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, label: `P${index}`, body: "Body" }));
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [tooMany] }), /2-9 points/u);

  const duplicate = structuredClone(fixture.slides[0]);
  duplicate.items[1].id = duplicate.items[0].id;
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [duplicate] }), /ids must be unique/u);

  const overemphasized = structuredClone(fixture.slides[1]);
  overemphasized.items[0].emphasis = true;
  overemphasized.items[1].emphasis = true;
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [overemphasized] }), /at most one point/u);
});

test("SW031 rejects unequal peer widths and off-center incomplete rows", () => {
  const plan = compileDeck(fixture);
  const slide = plan.slides.find((item) => item.id === "five-points");
  const group = slide.layoutContract.peerGroups[0];
  slide.shapes.find((shape) => shape.id === group.memberIds.at(-1)).position.left += 7;
  const report = lintPlan(plan);
  assert.equal(report.valid, false);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW031" && item.slideId === "five-points"));
});

test("opposition preserves a balanced decision boundary and optional synthesis band", () => {
  const plan = compileDeck(fixture);
  const slide = plan.slides.find((item) => item.layout === "opposition");
  const group = slide.layoutContract.peerGroups[0];
  const [left, right] = group.memberIds.map((id) => slide.shapes.find((shape) => shape.id === id));
  assert.equal(left.position.width, right.position.width);
  assert.equal(right.position.left - (left.position.left + left.position.width), group.gap);
  assert.ok(slide.shapes.some((shape) => shape.id.endsWith("-synthesis") && shape.type === "text"));
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
});

test("polygon-cycle compiles native triangle through dodecagon segmented relationship topologies", () => {
  const plan = compileDeck(fixture);
  const polygons = plan.slides.filter((slide) => slide.layout === "polygon-cycle");
  assert.deepEqual(polygons.map((slide) => slide.layoutContract.polygonTopology.sideCount), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(polygons.map((slide) => slide.layoutContract.polygonTopology.geometry), ["triangle", "rect", "pentagon", "hexagon", "heptagon", "octagon", "nonagon", "decagon", "undecagon", "dodecagon"]);
  for (const slide of polygons) {
    const topology = slide.layoutContract.polygonTopology;
    const segments = topology.segmentShapeIds.map((id) => slide.shapes.find((shape) => shape.id === id));
    assert.equal(segments.length, topology.sideCount);
    assert.ok(segments.every((segment) => segment.type === "shape" && segment.geometry === "trapezoid" && segment.editable === true));
    assert.equal(topology.nodeSurfaceIds.length, topology.sideCount);
    assert.equal(topology.ringBounds.width, topology.ringBounds.height);
    assert.equal(topology.connectorMode, "none");
    assert.deepEqual(topology.connectorShapeIds, []);
    assert.equal(topology.centerPlacement, topology.sideCount === 3 ? "triangle-inscribed-visual-center" : "visual-centroid");
    assert.equal(topology.vertexCenters.length, topology.sideCount);
    const radii = topology.vertexCenters.map((vertex) => Math.hypot(vertex.x - topology.circumcircle.centerX, vertex.y - topology.circumcircle.centerY));
    const edgeLengths = topology.vertexCenters.map((vertex, vertexIndex) => {
      const next = topology.vertexCenters[(vertexIndex + 1) % topology.sideCount];
      return Math.hypot(next.x - vertex.x, next.y - vertex.y);
    });
    const apothems = topology.vertexCenters.map((vertex, vertexIndex) => {
      const next = topology.vertexCenters[(vertexIndex + 1) % topology.sideCount];
      return Math.hypot((vertex.x + next.x) / 2 - topology.circumcircle.centerX, (vertex.y + next.y) / 2 - topology.circumcircle.centerY);
    });
    assert.ok(radii.every((value) => Math.abs(value - topology.regularity.vertexRadius) < 1e-9));
    assert.ok(edgeLengths.every((value) => Math.abs(value - topology.regularity.edgeLength) < 1e-9));
    assert.ok(apothems.every((value) => Math.abs(value - topology.regularity.apothem) < 1e-9));
    assert.equal(topology.regularity.aspectRatio, 1);
    const center = slide.shapes.find((shape) => shape.id === topology.centerSurfaceId);
    if (topology.sideCount === 3) {
      const zone = topology.centerSafeZone;
      assert.equal(zone.kind, "largest-axis-aligned-inscribed-rectangle");
      assert.ok(center.position.left >= zone.left && center.position.top >= zone.top);
      assert.ok(center.position.left + center.position.width <= zone.left + zone.width);
      assert.ok(center.position.top + center.position.height <= zone.top + zone.height);
      assert.equal(center.position.left + center.position.width / 2, zone.visualCenterX);
      assert.equal(center.position.top + center.position.height / 2, zone.visualCenterY);
    } else {
      assert.equal(center.position.left + center.position.width / 2, topology.circumcircle.centerX);
      assert.equal(center.position.top + center.position.height / 2, topology.circumcircle.centerY);
    }
  }
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
});

test("polygon-cycle rejects decorative count matching and SW032 catches vertex drift", () => {
  const invalidRelationship = structuredClone(fixture.slides.find((slide) => slide.id === "triangle-system"));
  invalidRelationship.relationship = "three-items";
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [invalidRelationship] }), /relationship must be/u);

  const tooFew = structuredClone(invalidRelationship);
  tooFew.relationship = "system";
  tooFew.items = tooFew.items.slice(0, 2);
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [tooFew] }), /3-12 related points/u);

  const tooMany = structuredClone(fixture.slides.find((slide) => slide.id === "dodecagon-cycle"));
  tooMany.items.push({ id: "thirteenth", label: "Thirteenth", body: "Too many" });
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [tooMany] }), /3-12 related points/u);

  const longMarker = structuredClone(fixture.slides.find((slide) => slide.id === "triangle-system"));
  longMarker.items[0].marker = "LONG";
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [longMarker] }), /marker must contain at most 3 characters/u);

  const plan = compileDeck(fixture);
  const slide = plan.slides.find((item) => item.id === "octagon-system");
  const segmentId = slide.layoutContract.polygonTopology.segmentShapeIds[2];
  slide.shapes.find((shape) => shape.id === segmentId).position.left += 6;
  const report = lintPlan(plan);
  assert.equal(report.valid, false);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW032" && item.slideId === "octagon-system"));

  const trianglePlan = compileDeck(fixture);
  const triangle = trianglePlan.slides.find((item) => item.id === "triangle-system");
  const triangleCenter = triangle.shapes.find((shape) => shape.id === triangle.layoutContract.polygonTopology.centerSurfaceId);
  triangleCenter.position.left -= 18;
  assert.ok(lintPlan(trianglePlan).diagnostics.some((item) => item.ruleId === "SW032" && item.slideId === triangle.id));

  const squarePlan = compileDeck(fixture);
  const squareSlide = squarePlan.slides.find((item) => item.id === "square-system");
  squareSlide.layoutContract.polygonTopology.vertexCenters[0].x += 5;
  assert.ok(lintPlan(squarePlan).diagnostics.some((item) => item.ruleId === "SW032" && item.slideId === squareSlide.id));

  const missingVerticesPlan = compileDeck(fixture);
  const missingVerticesSlide = missingVerticesPlan.slides.find((item) => item.id === "pentagon-cycle");
  delete missingVerticesSlide.layoutContract.polygonTopology.vertexCenters;
  assert.doesNotThrow(() => lintPlan(missingVerticesPlan));
  assert.ok(lintPlan(missingVerticesPlan).diagnostics.some((item) => item.ruleId === "SW032" && item.slideId === missingVerticesSlide.id));

  const missingRingPlan = compileDeck(fixture);
  const missingRingSlide = missingRingPlan.slides.find((item) => item.id === "hexagon-system");
  delete missingRingSlide.layoutContract.polygonTopology.ringBounds;
  assert.doesNotThrow(() => lintPlan(missingRingPlan));
  assert.ok(lintPlan(missingRingPlan).diagnostics.some((item) => item.ruleId === "SW032" && item.slideId === missingRingSlide.id));
});

test("quadrant, chevron, and icon-network archetypes compile as editable structural graphics", () => {
  const plan = compileDeck(fixture);
  const quadrant = plan.slides.find((slide) => slide.id === "quadrant-focus");
  const flow = plan.slides.find((slide) => slide.id === "chevron-flow");
  const networks = plan.slides.filter((slide) => slide.layout === "icon-network");

  assert.equal(quadrant.layoutContract.quadrantTopology.zoneSurfaceIds.length, 4);
  assert.equal(quadrant.layoutContract.quadrantTopology.dividerMode, "center-terminated-underlay");
  assert.equal(flow.layoutContract.flowTopology.connectorMode, "intrinsic");
  assert.ok(flow.layoutContract.flowTopology.stepSurfaceIds.every((id) => flow.shapes.find((shape) => shape.id === id)?.geometry === "chevron"));
  assert.deepEqual(networks.map((slide) => slide.layoutContract.networkTopology.topology), ["honeycomb", "pyramid", "square"]);
  assert.equal(networks[0].layoutContract.networkTopology.connectorShapeIds.length, 0);
  assert.ok(networks.slice(1).every((slide) => slide.layoutContract.networkTopology.connectorShapeIds.length > 0));
  assert.ok(networks.slice(1).every((slide) => slide.layoutContract.networkTopology.connectorWeightMode === "target-rim"));
  for (const network of networks.slice(1)) {
    const topology = network.layoutContract.networkTopology;
    const firstForeground = Math.min(...network.shapes.map((shape, shapeIndex) => ({ shape, shapeIndex })).filter(({ shape }) => topology.nodeSurfaceIds.some((id) => shape.id === id || shape.parentId === id)).map(({ shapeIndex }) => shapeIndex));
    for (const connectorId of topology.connectorShapeIds) {
      const connector = network.shapes.find((shape) => shape.id === connectorId);
      const target = network.shapes.find((shape) => shape.id === connector.semanticBinding.toSurfaceId);
      assert.ok(network.shapes.findIndex((shape) => shape.id === connector.id) < firstForeground);
      assert.equal(connector.semanticBinding.routeMode, "center-to-center-covered");
      assert.equal(connector.semanticBinding.zOrder, "underlay-before-nodes-and-text");
      assert.equal(connector.fill, target.line.color);
      assert.equal(connector.position.height, target.line.width);
    }
  }
  assert.ok(plan.slides.flatMap((slide) => slide.shapes).every((shape) => shape.editable === true));
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
});

test("SW033-SW035 reject unsafe structural drift", () => {
  const quadrantPlan = compileDeck(fixture);
  const quadrant = quadrantPlan.slides.find((slide) => slide.id === "quadrant-focus");
  const dividerId = quadrant.layoutContract.quadrantTopology.dividerShapeIds[0];
  quadrant.shapes.find((shape) => shape.id === dividerId).fill = "#000000";
  assert.ok(lintPlan(quadrantPlan).diagnostics.some((item) => item.ruleId === "SW033" && item.slideId === quadrant.id));

  const flowPlan = compileDeck(fixture);
  const flow = flowPlan.slides.find((slide) => slide.id === "chevron-flow");
  const secondStep = flow.shapes.find((shape) => shape.id === flow.layoutContract.flowTopology.stepSurfaceIds[1]);
  secondStep.position.left += 5;
  assert.ok(lintPlan(flowPlan).diagnostics.some((item) => item.ruleId === "SW034" && item.slideId === flow.id));

  const networkPlan = compileDeck(fixture);
  const network = networkPlan.slides.find((slide) => slide.id === "pyramid-network");
  const connector = network.shapes.find((shape) => shape.id === network.layoutContract.networkTopology.connectorShapeIds[0]);
  connector.fill = "#000000";
  assert.ok(lintPlan(networkPlan).diagnostics.some((item) => item.ruleId === "SW035" && item.slideId === network.id));

  const routePlan = compileDeck(fixture);
  const routedNetwork = routePlan.slides.find((slide) => slide.id === "pyramid-network");
  const routedConnector = routedNetwork.shapes.find((shape) => shape.id === routedNetwork.layoutContract.networkTopology.connectorShapeIds[0]);
  routedConnector.position.left += 4;
  assert.ok(lintPlan(routePlan).diagnostics.some((item) => item.ruleId === "SW035" && item.slideId === routedNetwork.id));
});

test("SW036 enforces one styling-only focus signal or one synthesis focus", () => {
  const plan = compileDeck(fixture);
  const focused = plan.slides.find((slide) => slide.id === "single-focus-network");
  assert.equal(focused.layoutContract.emphasisPattern.mode, "single-peer");
  const target = focused.shapes.find((shape) => shape.id === focused.layoutContract.emphasisPattern.targetSurfaceId);
  const peer = focused.shapes.find((shape) => focused.layoutContract.emphasisPattern.peerSurfaceIds.includes(shape.id) && shape.id !== target.id);
  peer.fill = target.fill;
  peer.line = structuredClone(target.line);
  assert.ok(lintPlan(plan).diagnostics.some((item) => item.ruleId === "SW036" && item.slideId === focused.id));

  const synthesisPlan = compileDeck(fixture);
  const quadrant = synthesisPlan.slides.find((slide) => slide.id === "quadrant-focus");
  assert.equal(quadrant.layoutContract.emphasisPattern.mode, "synthesis");
  const center = quadrant.shapes.find((shape) => shape.id === quadrant.layoutContract.emphasisPattern.targetSurfaceId);
  center.fill = "#FFFFFF";
  assert.ok(lintPlan(synthesisPlan).diagnostics.some((item) => item.ruleId === "SW036" && item.slideId === quadrant.id));

  const missingPeerPlan = compileDeck(fixture);
  const missingPeerSlide = missingPeerPlan.slides.find((slide) => slide.id === "single-focus-network");
  const missingPeerId = missingPeerSlide.layoutContract.emphasisPattern.peerSurfaceIds[0];
  missingPeerSlide.shapes = missingPeerSlide.shapes.filter((shape) => shape.id !== missingPeerId);
  assert.doesNotThrow(() => lintPlan(missingPeerPlan));
  assert.ok(lintPlan(missingPeerPlan).diagnostics.some((item) => item.ruleId === "SW036" && item.slideId === missingPeerSlide.id));
});

test("icon networks reject invalid topology counts and multiple focus points", () => {
  const honeycomb = structuredClone(fixture.slides.find((slide) => slide.id === "honeycomb-network"));
  honeycomb.items.pop();
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [honeycomb] }), /count does not match/u);

  const square = structuredClone(fixture.slides.find((slide) => slide.id === "single-focus-network"));
  square.items[0].emphasis = true;
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [square] }), /at most one network node/u);
});

test("copy adaptation preserves the new consulting layouts and their rich-text ownership", () => {
  const result = adaptDeckCopyToFit(fixture);
  const audit = auditAdaptedDeckCopy(fixture, result.spec, result.manifest, result.plan);
  assert.equal(audit.valid, true, JSON.stringify(audit.diagnostics, null, 2));
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "point-grid").length, 8);
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "opposition").length, 1);
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "polygon-cycle").length, 10);
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "quadrant-focus").length, 1);
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "chevron-flow").length, 1);
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "icon-network").length, 3);
});
