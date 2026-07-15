const CANVAS = Object.freeze({ width: 1280, height: 720 });

function box(id, left, top, width, height, fill, options = {}) {
  return {
    id,
    type: "shape",
    geometry: options.geometry ?? "rect",
    position: { left, top, width, height, rotation: options.rotation ?? 0 },
    fill,
    line: { color: options.lineColor ?? fill, width: options.lineWidth ?? 0 },
    radius: options.radius ?? 0,
  };
}

function text(id, left, top, width, height, value, fontSizePt, color, options = {}) {
  const baseRun = { text: typeof value === "string" ? value : "", bold: options.bold ?? false };
  return {
    id,
    type: "text",
    position: { left, top, width, height, rotation: options.rotation ?? 0 },
    text: {
      runs: Array.isArray(value)
        ? value.map((run) => ({
            text: run.text,
            bold: run.bold ?? false,
            italic: run.italic ?? false,
            color: run.color ?? color,
            typeface: run.typeface ?? options.typeface ?? "Arial",
            fontSizePt: run.fontSizePt ?? fontSizePt,
          }))
        : [{ ...baseRun, color, typeface: options.typeface ?? "Arial", fontSizePt }],
    },
    style: {
      fontSizePt,
      typeface: options.typeface ?? "Arial",
      color,
      bold: options.bold ?? false,
      italic: options.italic ?? false,
      alignment: options.alignment ?? "left",
      verticalAlignment: options.verticalAlignment ?? "top",
      lineHeight: options.lineHeight ?? 1.08,
      insets: options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
    },
  };
}

function inviteLandscape() {
  const c = { cream: "#F7F1E7", forest: "#173F35", terra: "#D97046", brass: "#C6A875" };
  return {
    id: "invite-landscape",
    family: "invite",
    orientation: "horizontal",
    groupName: "invite-landscape-editable",
    background: c.cream,
    elements: [
      box("invite-h-bg", 0, 0, 1280, 720, c.cream),
      box("invite-h-frame", 48, 48, 1184, 624, "none", { lineColor: c.forest, lineWidth: 2 }),
      box("invite-h-monogram", 104, 92, 82, 82, c.terra, { geometry: "ellipse" }),
      text("invite-h-monogram-text", 104, 103, 82, 60, "A", 32, c.cream, { typeface: "Georgia", bold: true, alignment: "center", verticalAlignment: "middle" }),
      text("invite-h-eyebrow", 104, 206, 520, 30, "AN EVENING AROUND THE TABLE", 14, c.terra, { bold: true }),
      text("invite-h-title", 104, 252, 600, 172, "AFTERGLOW\nSUPPER", 44, c.forest, { typeface: "Georgia", bold: true, lineHeight: 0.96 }),
      text("invite-h-subtitle", 108, 444, 480, 64, "Seasonal plates, warm light,\nand conversations that linger.", 20, c.forest, { lineHeight: 1.2 }),
      box("invite-h-divider", 716, 96, 2, 528, c.brass),
      box("invite-h-detail-panel", 774, 116, 382, 360, c.forest, { radius: 16 }),
      text("invite-h-date", 808, 156, 314, 54, [{ text: "SATURDAY  ", bold: true }, { text: "24 OCTOBER", bold: false }], 18, c.cream),
      text("invite-h-time", 808, 230, 314, 54, [{ text: "ARRIVE  ", bold: true }, { text: "7:00 PM", bold: false }], 18, c.cream),
      text("invite-h-place", 808, 304, 314, 92, [{ text: "PLACE  ", bold: true }, { text: "THE GLASSHOUSE\n18 WILLOW LANE", bold: false }], 18, c.cream, { lineHeight: 1.18 }),
      text("invite-h-rsvp", 778, 520, 374, 68, [{ text: "RSVP  ", bold: true }, { text: "BY 10 OCTOBER\nHELLO@AFTERGLOW.CO", bold: false }], 14, c.forest, { lineHeight: 1.18 }),
      box("invite-h-dot-1", 1170, 90, 18, 18, c.terra, { geometry: "ellipse" }),
      box("invite-h-dot-2", 1192, 112, 8, 8, c.brass, { geometry: "ellipse" }),
      box("invite-h-stem", 1178, 128, 2, 76, c.forest, { rotation: -18 }),
    ],
  };
}

function brochureLandscape() {
  const c = { navy: "#0B3347", coral: "#F06A55", sky: "#BCE3E8", sand: "#F4E9D7", ink: "#10252E", white: "#FFFFFF" };
  const elements = [
    box("brochure-h-bg", 0, 0, 1280, 720, c.sand),
    box("brochure-h-left", 0, 0, 420, 720, c.navy),
    box("brochure-h-center", 420, 0, 430, 720, c.sand),
    box("brochure-h-right", 850, 0, 430, 720, c.sky),
    box("brochure-h-fold-1", 418, 0, 2, 720, c.coral),
    box("brochure-h-fold-2", 848, 0, 2, 720, c.coral),
    text("brochure-h-kicker", 48, 48, 324, 28, "CITY PREPAREDNESS GUIDE", 14, c.coral, { bold: true }),
    text("brochure-h-left-title", 48, 92, 324, 104, "Four steps\nbefore noon", 32, c.white, { bold: true, lineHeight: 1.02 }),
    box("brochure-h-timeline", 76, 238, 3, 330, c.coral),
    text("brochure-h-center-title", 464, 54, 338, 80, "Heat-ready\nneighborhoods", 28, c.ink, { bold: true, lineHeight: 1.02 }),
    text("brochure-h-center-body", 464, 160, 338, 164, "Extreme heat is local. Shade, water, neighbor check-ins, and early action make every block safer.", 16, c.ink, { lineHeight: 1.26 }),
    box("brochure-h-callout", 464, 360, 338, 132, c.coral, { radius: 12 }),
    text("brochure-h-callout-text", 488, 382, 290, 88, "Check on someone\nbefore the hottest hour.", 20, c.white, { bold: true, lineHeight: 1.08 }),
    text("brochure-h-right-title", 894, 54, 338, 68, "Cooling impact", 24, c.navy, { bold: true }),
    text("brochure-h-right-caption", 894, 128, 338, 52, "Relative comfort gain by action", 14, c.navy),
  ];
  const timeline = [
    ["08:00", "OPEN CURTAINS"],
    ["09:00", "FILL WATER"],
    ["10:00", "CHECK A NEIGHBOR"],
    ["11:00", "MOVE TO SHADE"],
  ];
  timeline.forEach(([time, label], index) => {
    const y = 238 + index * 94;
    elements.push(box(`brochure-h-step-${index}`, 61, y, 32, 32, c.coral, { geometry: "ellipse" }));
    elements.push(text(`brochure-h-step-time-${index}`, 112, y - 1, 86, 28, time, 14, c.coral, { bold: true }));
    elements.push(text(`brochure-h-step-label-${index}`, 204, y - 1, 168, 48, label, 14, c.white, { bold: true }));
  });
  const bars = [
    ["SHADE", 260, c.navy],
    ["WATER", 218, c.coral],
    ["AIRFLOW", 174, "#4B8C96"],
    ["CHECK-IN", 132, "#6C7B84"],
  ];
  bars.forEach(([label, width, color], index) => {
    const y = 224 + index * 86;
    elements.push(text(`brochure-h-bar-label-${index}`, 894, y, 112, 28, label, 14, c.navy, { bold: true }));
    elements.push(box(`brochure-h-bar-${index}`, 894, y + 34, width, 24, color, { radius: 8 }));
  });
  return { id: "brochure-landscape", family: "brochure", orientation: "horizontal", groupName: "brochure-landscape-editable", background: c.sand, elements };
}

function websiteLandscape() {
  const c = { ink: "#0A1020", off: "#FAFAF7", lime: "#C6FF72", violet: "#7A5AF8", lavender: "#A5B4FC", gray: "#667085", white: "#FFFFFF" };
  const elements = [
    box("web-h-bg", 0, 0, 1280, 720, c.off),
    text("web-h-logo", 60, 36, 160, 38, "relay/", 24, c.ink, { bold: true }),
    text("web-h-nav", 416, 41, 420, 26, "PRODUCT     CUSTOMERS     PRICING", 14, c.gray, { bold: true, alignment: "center" }),
    box("web-h-nav-cta", 1080, 28, 140, 48, c.ink, { radius: 12 }),
    text("web-h-nav-cta-text", 1080, 38, 140, 28, "START FREE", 14, c.white, { bold: true, alignment: "center", verticalAlignment: "middle" }),
    text("web-h-eyebrow", 60, 142, 480, 30, "OPERATIONS THAT MOVE WITH YOU", 14, c.violet, { bold: true }),
    text("web-h-title", 60, 188, 540, 180, "The calmest way\nto run fast.", 44, c.ink, { bold: true, lineHeight: 1.0 }),
    text("web-h-body", 60, 390, 500, 88, "Relay turns handoffs, signals, and decisions into one shared operating rhythm.", 20, c.gray, { lineHeight: 1.2 }),
    box("web-h-primary", 60, 510, 166, 56, c.lime, { radius: 12 }),
    text("web-h-primary-text", 60, 523, 166, 30, "BUILD A RELAY", 14, c.ink, { bold: true, alignment: "center", verticalAlignment: "middle" }),
    box("web-h-secondary", 244, 510, 166, 56, c.off, { lineColor: c.ink, lineWidth: 2, radius: 12 }),
    text("web-h-secondary-text", 244, 523, 166, 30, "WATCH 90 SEC", 14, c.ink, { bold: true, alignment: "center", verticalAlignment: "middle" }),
    box("web-h-window", 650, 132, 568, 446, c.ink, { radius: 18 }),
    box("web-h-window-top", 674, 154, 520, 42, "#161E33", { radius: 8 }),
    box("web-h-dot-a", 694, 169, 10, 10, c.lime, { geometry: "ellipse" }),
    box("web-h-dot-b", 712, 169, 10, 10, c.violet, { geometry: "ellipse" }),
    box("web-h-sidebar", 674, 214, 124, 338, "#161E33", { radius: 8 }),
    text("web-h-sidebar-text", 692, 238, 90, 180, "OVERVIEW\n\nSIGNALS\n\nPLANS\n\nNOTES", 12, c.lavender, { bold: true, lineHeight: 1.38 }),
    box("web-h-card", 818, 214, 376, 338, c.white, { radius: 12 }),
    text("web-h-card-title", 842, 238, 300, 42, "Momentum this week", 18, c.ink, { bold: true }),
    text("web-h-card-value", 842, 286, 180, 54, "84%", 32, c.violet, { bold: true }),
  ];
  [92, 138, 118, 184, 226, 196].forEach((height, index) => {
    elements.push(box(`web-h-chart-${index}`, 846 + index * 48, 504 - height, 28, height, index === 5 ? c.lime : c.lavender, { radius: 8 }));
  });
  return { id: "website-landscape", family: "website", orientation: "horizontal", groupName: "website-landscape-editable", background: c.off, elements };
}

function invitePortraitGraphic() {
  const c = { canvas: "#E9E5DD", cream: "#F7F1E7", forest: "#173F35", terra: "#D97046", brass: "#C6A875" };
  return {
    id: "invite-portrait-graphic",
    family: "invite",
    orientation: "vertical",
    groupName: "invite-portrait-editable",
    background: c.canvas,
    elements: [
      box("invite-v-canvas", 0, 0, 1280, 720, c.canvas),
      box("invite-v-card", 425, 50, 430, 620, c.cream),
      box("invite-v-frame", 449, 74, 382, 572, "none", { lineColor: c.forest, lineWidth: 2 }),
      box("invite-v-monogram", 596, 102, 88, 88, c.terra, { geometry: "ellipse" }),
      text("invite-v-monogram-text", 596, 116, 88, 56, "A", 32, c.cream, { typeface: "Georgia", bold: true, alignment: "center", verticalAlignment: "middle" }),
      text("invite-v-eyebrow", 485, 214, 310, 24, "AN EVENING AROUND THE TABLE", 12, c.terra, { bold: true, alignment: "center" }),
      text("invite-v-title", 485, 254, 310, 110, "AFTERGLOW\nSUPPER", 32, c.forest, { typeface: "Georgia", bold: true, alignment: "center", lineHeight: 0.96 }),
      box("invite-v-rule", 565, 390, 150, 2, c.brass),
      text("invite-v-details", 493, 418, 294, 86, "SATURDAY, 24 OCTOBER\n7:00 PM · THE GLASSHOUSE", 16, c.forest, { bold: true, alignment: "center", lineHeight: 1.22 }),
      text("invite-v-rsvp", 493, 548, 294, 54, [{ text: "RSVP  ", bold: true }, { text: "HELLO@AFTERGLOW.CO", bold: false }], 12, c.forest, { alignment: "center" }),
      box("invite-v-dot-1", 470, 106, 14, 14, c.terra, { geometry: "ellipse" }),
      box("invite-v-dot-2", 796, 604, 14, 14, c.terra, { geometry: "ellipse" }),
    ],
  };
}

function brochurePortraitGraphic() {
  const c = { canvas: "#DCE6E8", navy: "#0B3347", coral: "#F06A55", sky: "#BCE3E8", sand: "#F4E9D7", ink: "#10252E", white: "#FFFFFF" };
  const elements = [
    box("brochure-v-canvas", 0, 0, 1280, 720, c.canvas),
    box("brochure-v-page", 390, 42, 500, 636, c.sand),
    box("brochure-v-band", 390, 42, 500, 118, c.navy),
    text("brochure-v-title", 430, 68, 400, 72, "Heat-ready neighborhoods", 28, c.white, { bold: true, lineHeight: 1.0 }),
    text("brochure-v-spine", 302, 341, 220, 38, "CITY PREPAREDNESS", 12, c.coral, { bold: true, alignment: "center", verticalAlignment: "middle", rotation: -90 }),
    text("brochure-v-body", 458, 192, 386, 108, "Plan early. Share water. Check on neighbors. Move activity toward shade before peak heat.", 16, c.ink, { lineHeight: 1.24 }),
    box("brochure-v-timeline", 470, 340, 3, 190, c.coral),
    text("brochure-v-chart-title", 628, 324, 216, 30, "Cooling impact", 18, c.navy, { bold: true }),
  ];
  [["08", "OPEN"], ["09", "WATER"], ["10", "CHECK"]].forEach(([time, label], index) => {
    const y = 340 + index * 78;
    elements.push(box(`brochure-v-step-${index}`, 456, y, 30, 30, c.coral, { geometry: "ellipse" }));
    elements.push(text(`brochure-v-step-label-${index}`, 500, y, 104, 32, `${time}:00  ${label}`, 12, c.navy, { bold: true }));
  });
  [["SHADE", 182, c.navy], ["WATER", 148, c.coral], ["AIR", 112, "#4B8C96"]].forEach(([label, width, color], index) => {
    const y = 380 + index * 68;
    elements.push(text(`brochure-v-bar-label-${index}`, 628, y, 90, 24, label, 12, c.navy, { bold: true }));
    elements.push(box(`brochure-v-bar-${index}`, 628, y + 28, width, 18, color, { radius: 8 }));
  });
  elements.push(text("brochure-v-footer", 458, 594, 386, 42, "COOLING CENTER · 18 WILLOW LANE", 12, c.navy, { bold: true, alignment: "center" }));
  return { id: "brochure-portrait-graphic", family: "brochure", orientation: "vertical", groupName: "brochure-portrait-editable", background: c.canvas, elements };
}

function websiteMobileGraphic() {
  const c = { canvas: "#D9D4FF", ink: "#0A1020", off: "#FAFAF7", lime: "#C6FF72", violet: "#7A5AF8", lavender: "#A5B4FC", gray: "#667085", white: "#FFFFFF" };
  const elements = [
    box("web-v-canvas", 0, 0, 1280, 720, c.canvas),
    box("web-v-phone", 445, 38, 390, 644, c.off, { radius: 24, lineColor: c.ink, lineWidth: 2 }),
    text("web-v-logo", 474, 66, 130, 30, "relay/", 20, c.ink, { bold: true }),
    box("web-v-menu", 762, 66, 44, 32, c.ink, { radius: 8 }),
    text("web-v-menu-text", 762, 70, 44, 24, "≡", 18, c.white, { bold: true, alignment: "center" }),
    text("web-v-eyebrow", 474, 130, 300, 24, "ONE OPERATING RHYTHM", 12, c.violet, { bold: true }),
    text("web-v-title", 474, 170, 310, 104, "The calmest\nway to run fast.", 28, c.ink, { bold: true, lineHeight: 1.0 }),
    text("web-v-body", 474, 286, 300, 64, "Signals, handoffs, and decisions in one shared flow.", 16, c.gray, { lineHeight: 1.2 }),
    box("web-v-primary", 474, 366, 300, 48, c.lime, { radius: 10 }),
    text("web-v-primary-text", 474, 376, 300, 28, "BUILD A RELAY", 12, c.ink, { bold: true, alignment: "center", verticalAlignment: "middle" }),
    box("web-v-card", 474, 438, 300, 138, c.ink, { radius: 14 }),
    text("web-v-card-title", 496, 458, 240, 28, "Momentum", 16, c.white, { bold: true }),
    text("web-v-card-value", 496, 498, 92, 42, "84%", 24, c.lime, { bold: true }),
  ];
  [44, 68, 54, 82].forEach((height, index) => {
    elements.push(box(`web-v-bar-${index}`, 610 + index * 34, 550 - height, 20, height, index === 3 ? c.lime : c.lavender, { radius: 6 }));
  });
  elements.push(text("web-v-stat", 474, 610, 300, 44, "12 SIGNALS · 4 DECISIONS · 0 BLOCKERS", 12, c.gray, { bold: true, alignment: "center" }));
  return { id: "website-mobile-graphic", family: "website", orientation: "vertical", groupName: "website-mobile-editable", background: c.canvas, elements };
}

export const FIDELITY_SUITE = Object.freeze({
  version: "0.2",
  canvas: CANVAS,
  slides: [
    inviteLandscape(),
    brochureLandscape(),
    websiteLandscape(),
    invitePortraitGraphic(),
    brochurePortraitGraphic(),
    websiteMobileGraphic(),
  ],
});
