const CANDIDATE_CODE = /^D-[0-9A-F]{10}$/u;
const DECK_PATH = /^(?:\.\.\/)?decks\/P-[0-9A-F]{10}\.pptx$/u;
const DIMENSION = /^[a-z][A-Za-z0-9]{2,31}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function embeddedJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
}

export function validateReviewerFormConfig(config) {
  invariant(config?.schemaVersion === "slidewright-c13-review-form/v1", "C13 reviewer form schemaVersion is invalid.");
  invariant(["blind-expert", "target-user"].includes(config.role), "C13 reviewer form role is invalid.");
  invariant(typeof config.assignmentId === "string" && config.assignmentId.length > 0, "C13 reviewer form assignmentId is missing.");
  invariant(Array.isArray(config.reviews) && config.reviews.length > 0, "C13 reviewer form has no assigned designs.");
  invariant(new Set(config.reviews.map((review) => review.candidateCode)).size === config.reviews.length, "C13 reviewer form repeats a candidate.");
  for (const review of config.reviews) {
    invariant(CANDIDATE_CODE.test(review.candidateCode), `C13 reviewer form candidate code is invalid: ${review.candidateCode}`);
    if (config.role === "blind-expert") {
      invariant(Object.keys(review).every((key) => ["candidateCode", "image"].includes(key)), "C13 expert form leaks non-blinded candidate fields.");
      invariant(review.image === `images/${review.candidateCode}.png`, `C13 expert image path is invalid: ${review.image}`);
    } else {
      invariant(Object.keys(review).every((key) => ["candidateCode", "deck", "slide"].includes(key)), "C13 target-user form leaks non-blinded candidate fields.");
      invariant(DECK_PATH.test(review.deck), `C13 target-user deck path is invalid: ${review.deck}`);
      invariant(Number.isInteger(review.slide) && review.slide >= 1, `C13 target-user slide is invalid: ${review.slide}`);
    }
  }
  if (config.role === "blind-expert") {
    invariant(config.assignmentId === "expert-all-designs", "C13 expert form assignment is invalid.");
    invariant(Array.isArray(config.dimensions) && config.dimensions.length > 0, "C13 expert form dimensions are missing.");
    invariant(config.dimensions.every((dimension) => DIMENSION.test(dimension)), "C13 expert form has an invalid dimension.");
    invariant(new Set(config.dimensions).size === config.dimensions.length, "C13 expert form repeats a dimension.");
  } else {
    invariant(/^target-user-[1-5]$/u.test(config.assignmentId), "C13 target-user form assignment is invalid.");
    invariant(!("dimensions" in config), "C13 target-user form must not include expert dimensions.");
  }
  invariant(/^[a-z0-9-]+-response\.json$/u.test(config.downloadName), "C13 reviewer form download name is invalid.");
  invariant(typeof config.rubric === "string" && /^(?:\.\.\/)?RUBRIC\.md$/u.test(config.rubric), "C13 reviewer form rubric path is invalid.");
  return true;
}

export function buildExpertReviewerFormConfig({ candidates, dimensions }) {
  const config = {
    schemaVersion: "slidewright-c13-review-form/v1",
    role: "blind-expert",
    assignmentId: "expert-all-designs",
    downloadName: "expert-all-designs-response.json",
    rubric: "RUBRIC.md",
    dimensions: [...dimensions],
    reviews: candidates.map((candidate) => ({ candidateCode: candidate.candidateCode, image: `images/${candidate.candidateCode}.png` })),
  };
  validateReviewerFormConfig(config);
  return config;
}

export function buildTargetUserReviewerFormConfig(routing) {
  const config = {
    schemaVersion: "slidewright-c13-review-form/v1",
    role: "target-user",
    assignmentId: routing.assignmentId,
    downloadName: `${routing.assignmentId}-response.json`,
    rubric: "../RUBRIC.md",
    reviews: routing.designs.map((design) => ({ candidateCode: design.candidateCode, deck: `../${design.deck}`, slide: design.slide })),
  };
  validateReviewerFormConfig(config);
  return config;
}

const APPLICATION = String.raw`
(function () {
  "use strict";
  const config = JSON.parse(document.getElementById("review-config").textContent);
  const state = new Map(config.reviews.map((review) => [review.candidateCode, {}]));
  const cards = document.getElementById("cards");
  const status = document.getElementById("status");
  const save = document.getElementById("save");
  const pseudonym = (config.role === "blind-expert" ? "expert-" : "user-") + randomToken();
  document.getElementById("pseudonym").textContent = pseudonym;

  function randomToken() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function element(tag, attributes, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === "class") node.className = value;
      else if (key === "for") node.htmlFor = value;
      else node.setAttribute(key, value);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fieldsetLegend(text) {
    const fieldset = element("fieldset", { class: "choice" });
    fieldset.append(element("legend", {}, text));
    return fieldset;
  }

  function radio(fieldset, name, value, labelText, onChange) {
    const id = name + "-" + value;
    const label = element("label", { for: id, class: "radio" });
    const input = element("input", { id, type: "radio", name, value, required: "required" });
    input.addEventListener("change", onChange);
    label.append(input, document.createTextNode(" " + labelText));
    fieldset.append(label);
  }

  function updateProgress() {
    let completed = 0;
    for (const review of config.reviews) {
      const current = state.get(review.candidateCode);
      if (config.role === "blind-expert") {
        if (typeof current.accepted === "boolean" && config.dimensions.every((dimension) => Number.isInteger(current.scores?.[dimension]))) completed += 1;
      } else if (typeof current.accepted === "boolean" && Number.isInteger(current.cleanupSeconds) && Number.isInteger(current.repairActions)) completed += 1;
    }
    status.textContent = completed + " / " + config.reviews.length + " designs complete";
  }

  function expertCard(review) {
    const current = state.get(review.candidateCode);
    current.scores = {};
    const card = element("article", { class: "card" });
    const heading = element("h2", {}, review.candidateCode);
    const link = element("a", { href: review.image, target: "_blank", rel: "noopener", class: "image-link" });
    link.append(element("img", { src: review.image, alt: "Blinded slide " + review.candidateCode, loading: "lazy" }));
    const acceptable = fieldsetLegend("Presentation-ready without any edit?");
    radio(acceptable, "accept-" + review.candidateCode, "yes", "Yes", () => { current.accepted = true; updateProgress(); });
    radio(acceptable, "accept-" + review.candidateCode, "no", "No", () => { current.accepted = false; updateProgress(); });
    const scores = element("div", { class: "scores" });
    for (const dimension of config.dimensions) {
      const id = review.candidateCode + "-" + dimension;
      const label = element("label", { for: id }, dimension.replace(/([A-Z])/g, " $1"));
      const select = element("select", { id, required: "required" });
      select.append(element("option", { value: "" }, "Choose 1-5"));
      for (let value = 1; value <= 5; value += 1) select.append(element("option", { value: String(value) }, String(value)));
      select.addEventListener("change", () => { current.scores[dimension] = select.value ? Number(select.value) : null; updateProgress(); });
      label.append(select);
      scores.append(label);
    }
    card.append(heading, link, acceptable, scores);
    return card;
  }

  function targetCard(review) {
    const current = state.get(review.candidateCode);
    const card = element("article", { class: "card" });
    card.append(element("h2", {}, review.candidateCode));
    card.append(element("p", { class: "route" }, "Opaque deck, slide " + review.slide));
    const controls = element("div", { class: "timer-controls" });
    const open = element("a", { href: review.deck, target: "_blank", rel: "noopener", class: "button" }, "Open deck + start timer");
    const stop = element("button", { type: "button", class: "button secondary" }, "Stop timer");
    const timer = element("output", { class: "timer", "aria-live": "polite" }, "Not started");
    open.addEventListener("click", () => {
      if (!current.startedAt) current.startedAt = Date.now();
      timer.textContent = "Timing…";
    });
    stop.addEventListener("click", () => {
      if (!current.startedAt) { timer.textContent = "Open the deck first."; return; }
      current.cleanupSeconds = Math.max(1, Math.round((Date.now() - current.startedAt) / 1000));
      cleanup.value = String(current.cleanupSeconds);
      timer.textContent = current.cleanupSeconds + " seconds";
      updateProgress();
    });
    controls.append(open, stop, timer);
    const acceptable = fieldsetLegend("Was it presentation-ready without edits?");
    radio(acceptable, "accept-" + review.candidateCode, "yes", "Yes — no edits required", () => {
      current.accepted = true;
      current.cleanupSeconds = 0;
      current.repairActions = 0;
      cleanup.value = "0";
      repairs.value = "0";
      cleanup.disabled = true;
      repairs.disabled = true;
      updateProgress();
    });
    radio(acceptable, "accept-" + review.candidateCode, "no", "No — I made or would require edits", () => {
      current.accepted = false;
      cleanup.disabled = false;
      repairs.disabled = false;
      if (current.cleanupSeconds === 0) current.cleanupSeconds = null;
      cleanup.value = current.cleanupSeconds ?? "";
      repairs.value = current.repairActions ?? "";
      updateProgress();
    });
    const measures = element("div", { class: "measures" });
    const cleanupLabel = element("label", { for: review.candidateCode + "-cleanup" }, "Cleanup seconds");
    const cleanup = element("input", { id: review.candidateCode + "-cleanup", type: "number", min: "0", max: "3600", step: "1", inputmode: "numeric" });
    cleanup.addEventListener("input", () => { current.cleanupSeconds = cleanup.value === "" ? null : Number(cleanup.value); updateProgress(); });
    cleanupLabel.append(cleanup);
    const repairsLabel = element("label", { for: review.candidateCode + "-repairs" }, "Distinct repair actions");
    const repairs = element("input", { id: review.candidateCode + "-repairs", type: "number", min: "0", max: "50", step: "1", inputmode: "numeric" });
    repairs.addEventListener("input", () => { current.repairActions = repairs.value === "" ? null : Number(repairs.value); updateProgress(); });
    repairsLabel.append(repairs);
    measures.append(cleanupLabel, repairsLabel);
    card.append(controls, acceptable, measures);
    return card;
  }

  for (const review of config.reviews) cards.append(config.role === "blind-expert" ? expertCard(review) : targetCard(review));

  function attestationsComplete() {
    return Array.from(document.querySelectorAll("#attestations input[type=checkbox]")).every((input) => input.checked);
  }

  function collect() {
    if (!attestationsComplete()) throw new Error("Complete every eligibility, privacy, and blindness attestation.");
    const reviews = config.reviews.map((review) => {
      const current = state.get(review.candidateCode);
      if (typeof current.accepted !== "boolean") throw new Error(review.candidateCode + ": choose first-open acceptance.");
      if (config.role === "blind-expert") {
        const scores = {};
        for (const dimension of config.dimensions) {
          const value = current.scores?.[dimension];
          if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(review.candidateCode + ": score every dimension from 1 to 5.");
          scores[dimension] = value;
        }
        return { candidateCode: review.candidateCode, firstOpenAcceptable: current.accepted, scores };
      }
      if (!Number.isInteger(current.cleanupSeconds) || current.cleanupSeconds < 0 || current.cleanupSeconds > 3600) throw new Error(review.candidateCode + ": cleanup seconds must be an integer from 0 to 3600.");
      if (!Number.isInteger(current.repairActions) || current.repairActions < 0 || current.repairActions > 50) throw new Error(review.candidateCode + ": repair actions must be an integer from 0 to 50.");
      if (current.accepted !== (current.cleanupSeconds === 0 && current.repairActions === 0)) throw new Error(review.candidateCode + ": acceptance is allowed only with zero cleanup and zero repairs.");
      return { candidateCode: review.candidateCode, firstOpenAcceptable: current.accepted, cleanupSeconds: current.cleanupSeconds, repairActions: current.repairActions };
    });
    const target = config.role === "target-user";
    return {
      schemaVersion: "slidewright-c13-response/v1",
      participant: {
        id: pseudonym,
        role: config.role,
        human: true,
        independent: true,
        agentOrAi: false,
        implementationTeamMember: false,
        professionalPresentationExpert: !target,
        monthlyProfessionalDeckUse: target,
      },
      attestations: {
        candidateOriginsHidden: true,
        conditionLabelsHidden: true,
        adminKeyUnavailableBeforeSubmission: true,
        noDirectPersonalData: true,
        timedWithoutAssistance: target,
      },
      assignmentId: config.assignmentId,
      reviews,
      submittedAt: new Date().toISOString(),
    };
  }

  save.addEventListener("click", () => {
    try {
      const payload = collect();
      const blob = new Blob([JSON.stringify(payload, null, 2) + "\\n"], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = config.downloadName;
      link.click();
      URL.revokeObjectURL(link.href);
      status.textContent = "Response downloaded. Send that JSON file to the study administrator.";
    } catch (error) {
      status.textContent = error.message;
      status.focus();
    }
  });

  updateProgress();
}());
`;

function renderAttestations(role) {
  const roleSpecific = role === "blind-expert"
    ? "I am a professional presentation expert qualified to assess all assigned designs."
    : "I create, edit, review, or present professional slide decks at least monthly, and I will time the work without assistance.";
  return [
    "I am a human participant, independent from Slidewright's implementation team, and I am not using an AI reviewer.",
    roleSpecific,
    "The candidate origins and condition labels were hidden from me.",
    "I did not access the administrator key before completing this response.",
    "This form contains no name, email address, employer, or other direct personal data.",
  ].map((text, index) => `<label><input type="checkbox" id="attestation-${index + 1}" required> ${text}</label>`).join("\n");
}

export function renderReviewerForm(config) {
  validateReviewerFormConfig(config);
  const title = config.role === "blind-expert" ? "Blind expert review" : `Target-user review ${config.assignmentId}`;
  const intro = config.role === "blind-expert"
    ? "Open each blinded image at full size. Judge only what is visible and score every dimension using the anchored rubric."
    : "Use Open deck + start timer for each assigned slide. Stop only when you would present it professionally; record distinct repair actions.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <link rel="icon" href="data:,">
  <title>${title} · Slidewright C13</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Aptos, Arial, sans-serif; color: #17202a; background: #f3f5f7; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header, main, footer { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 32px 0 20px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    h2 { margin: 0; font-size: 20px; }
    p { line-height: 1.5; }
    .notice, .attestations, .card, footer { background: white; border: 1px solid #dce1e6; border-radius: 12px; padding: 20px; }
    .notice { border-left: 6px solid #ffbf00; }
    .attestations { margin: 20px 0; display: grid; gap: 12px; }
    .attestations legend { font-weight: 700; padding: 0 6px; }
    .attestations label { display: block; line-height: 1.4; }
    .identity { font-family: ui-monospace, Consolas, monospace; }
    #status { font-weight: 700; min-height: 24px; }
    #cards { display: grid; gap: 20px; }
    .card { display: grid; gap: 16px; }
    .image-link img { display: block; width: 100%; height: auto; border: 1px solid #c9d0d7; }
    fieldset { border: 0; padding: 0; margin: 0; }
    legend { font-weight: 700; margin-bottom: 8px; }
    .radio { margin-right: 24px; }
    .scores, .measures { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .scores label, .measures label { display: grid; gap: 6px; text-transform: capitalize; }
    select, input[type=number] { min-height: 42px; padding: 8px; font: inherit; }
    .timer-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .button { appearance: none; border: 0; border-radius: 8px; background: #1769e0; color: white; padding: 11px 16px; text-decoration: none; font: 700 15px/1.2 inherit; cursor: pointer; }
    .button.secondary { background: #e7edf5; color: #17202a; }
    .timer { font-variant-numeric: tabular-nums; font-weight: 700; }
    footer { margin-top: 24px; margin-bottom: 40px; position: sticky; bottom: 12px; box-shadow: 0 6px 24px rgb(0 0 0 / 14%); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
    @media (max-width: 640px) { footer { position: static; } .radio { display: block; margin: 8px 0; } }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <p>${intro} Read the <a href="${config.rubric}" target="_blank" rel="noopener">anchored rubric</a> first.</p>
    <div class="notice"><strong>Blindness and privacy:</strong> do not inspect the administrator key or research file origins. The form creates a random pseudonym, collects no free-form text, makes no network requests, and downloads the response only to this device.</div>
    <p>Your generated pseudonym: <span class="identity" id="pseudonym"></span></p>
  </header>
  <main>
    <fieldset class="attestations" id="attestations">
      <legend>Required attestations</legend>
      ${renderAttestations(config.role)}
    </fieldset>
    <p id="status" tabindex="-1" aria-live="polite"></p>
    <section id="cards" aria-label="Assigned blinded designs"></section>
  </main>
  <footer>
    <span>Nothing is uploaded automatically. Send the downloaded JSON file to the study administrator.</span>
    <button type="button" class="button" id="save">Validate and download response JSON</button>
  </footer>
  <script type="application/json" id="review-config">${embeddedJson(config)}</script>
  <script>${APPLICATION}</script>
</body>
</html>
`;
}
