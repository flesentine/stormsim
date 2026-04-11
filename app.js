import { evaluateAudit } from "./auditEvaluator.js";
import {
  buildDocumentationFeedback,
  evaluateDocumentationSubmission,
  getDocumentationFieldInitialValues,
  getDocumentationScoreLabel,
} from "./documentationEvaluator.js";
import {
  applyEnterNodeEffects,
  createInitialRuntimeState,
  getCurrentNode,
  getNodeById,
  resolveNodeImageSrc,
  selectChoice,
  submitDocumentation,
} from "./scenarioEngine.js";
import { loadScenario } from "./scenarioLoader.js";

const IMAGE_ALIASES = {
  "img_unlabeled_barrels.jpg": "img_unlabeled_barrels Medium.jpg",
};

const appState = {
  scenario: null,
  runtime: null,
  flash: null,
  docDraft: {},
  docErrors: {},
};

const root = document.querySelector("#app");

start().catch((error) => {
  console.error(error);
  root.innerHTML = `
    <section class="panel error-panel">
      <p class="eyebrow">StormSim Scenario Player</p>
      <h1>App failed to load</h1>
      <pre class="error-copy">${escapeHtml(String(error?.stack ?? error))}</pre>
    </section>
  `;
});

async function start() {
  const scenario = await loadScenario("./StormSim_S1_V4_2.json");
  appState.scenario = scenario;
  resetRun();

  root.addEventListener("click", handleClick);
  root.addEventListener("submit", handleSubmit);

  render();
}

function resetRun() {
  const initial = createInitialRuntimeState(appState.scenario);
  const startNode = getNodeById(appState.scenario, initial.current_node_id);
  appState.runtime = startNode
    ? applyEnterNodeEffects(appState.scenario, initial, startNode)
    : initial;
  appState.flash = {
    tone: "success",
    lines: ["Scenario ready."],
  };
  appState.docDraft = {};
  appState.docErrors = {};
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const action = button.dataset.action;

  if (action === "reset") {
    resetRun();
    render();
    return;
  }

  if (action === "choice") {
    const choiceId = button.dataset.choiceId;
    if (!choiceId) return;

    const result = selectChoice(appState.scenario, appState.runtime, choiceId);
    appState.runtime = result.nextState;
    appState.flash = result.dialogueResponse
      ? { tone: "neutral", lines: [result.dialogueResponse] }
      : null;
    appState.docDraft = {};
    appState.docErrors = {};
    render();
  }
}

function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.kind !== "documentation") return;

  event.preventDefault();

  const node = getCurrentNode(appState.scenario, appState.runtime);
  if (!node || node.node_type !== "documentation") return;

  const values = Object.fromEntries(new FormData(form).entries());
  const evidenceIds = appState.runtime.evidence_found.map((item) => item.evidence_id);
  const evaluation = evaluateDocumentationSubmission(node, values, evidenceIds);

  appState.docDraft[node.node_id] = values;
  appState.docErrors[node.node_id] = evaluation.fieldErrors;

  if (Object.keys(evaluation.fieldErrors).length > 0) {
    appState.flash = {
      tone: "warning",
      lines: ["Please fix the highlighted documentation fields before continuing."],
    };
    render();
    return;
  }

  const result = submitDocumentation(
    appState.scenario,
    appState.runtime,
    node.node_id,
    values,
  );

  appState.runtime = result.nextState;
  appState.docErrors[node.node_id] = {};
  appState.flash = {
    tone: getDocumentationScoreLabel(
      result.allCoreFieldsCorrect,
      result.missingRequiredEvidence,
    ),
    lines: buildDocumentationFeedback(node, values, evidenceIds),
  };

  render();
}

function render() {
  const scenario = appState.scenario;
  const runtime = appState.runtime;
  const node = getCurrentNode(scenario, runtime);

  if (!node) {
    root.innerHTML = `<section class="panel error-panel"><h1>Current node not found.</h1></section>`;
    return;
  }

  const audit = node.node_type === "audit_result" ? evaluateAudit(scenario, runtime) : null;
  const imageSrc = getNodeImageSrc(scenario, node);

  root.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">StormSim Scenario Player</p>
          <h1>${escapeHtml(scenario.title)}</h1>
          <div class="hero-meta">
            <span class="pill">${escapeHtml(scenario.difficulty)}</span>
            <span class="pill">${scenario.estimated_minutes} minutes</span>
            <span class="pill">${escapeHtml(node.node_id)}</span>
          </div>
        </div>
        <button class="secondary-button" data-action="reset" type="button">Restart Scenario</button>
      </header>

      <main class="layout">
        <section class="panel main-card">
          ${imageSrc ? `<img class="node-image" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(node.prompt)}">` : ""}
          <div class="node-body">
            <p class="node-kicker">${escapeHtml(node.node_type.replace("_", " "))}</p>
            <h2>${escapeHtml(node.prompt)}</h2>
            <p class="context">${escapeHtml(node.context)}</p>
            ${appState.flash ? renderFlash(appState.flash) : ""}
            ${
              node.node_type === "documentation"
                ? renderDocumentationNode(node)
                : node.node_type === "audit_result"
                  ? renderAuditNode(runtime, audit)
                  : renderStandardNode(node)
            }
          </div>
        </section>

        <aside class="panel sidebar">
          <section>
            <h3>Score</h3>
            <div class="stat-grid">
              ${Object.entries(runtime.score)
                .map(
                  ([label, value]) => `
                    <div class="stat">
                      <div class="small">${escapeHtml(label)}</div>
                      <div class="stat-value">${value}</div>
                    </div>`,
                )
                .join("")}
            </div>
          </section>

          <section>
            <h3>Evidence Found</h3>
            <div class="detail-list">
              ${
                runtime.evidence_found.length
                  ? runtime.evidence_found
                      .map(
                        (item) => `
                          <div class="stat">
                            <strong>${escapeHtml(item.label ?? item.evidence_id)}</strong>
                            <div class="small">${escapeHtml(item.evidence_id)}</div>
                          </div>`,
                      )
                      .join("")
                  : `<div class="empty">No evidence found yet.</div>`
              }
            </div>
          </section>

          <section>
            <h3>Behavior Tags</h3>
            <div class="detail-list">
              ${
                runtime.behavior_tags.length
                  ? runtime.behavior_tags
                      .map(
                        (tag) => `
                          <div class="stat">
                            <strong>${escapeHtml(tag)}</strong>
                            <div class="small">${escapeHtml(scenario.behavior_tag_definitions?.[tag] ?? "Tracked by runtime state.")}</div>
                          </div>`,
                      )
                      .join("")
                  : `<div class="empty">No behavior concerns recorded.</div>`
              }
            </div>
          </section>

          <section>
            <h3>Visited Nodes</h3>
            <div class="small">${escapeHtml(runtime.visited_nodes.join(" -> "))}</div>
          </section>
        </aside>
      </main>
    </div>
  `;
}

function renderStandardNode(node) {
  return `
    <div class="choice-list">
      ${(node.choices ?? [])
        .map(
          (choice) => `
            <button class="choice-button" data-action="choice" data-choice-id="${escapeHtml(choice.choice_id)}" type="button">
              ${escapeHtml(choice.text)}
            </button>`,
        )
        .join("")}
    </div>
  `;
}

function renderDocumentationNode(node) {
  const draft = appState.docDraft[node.node_id] ?? getDocumentationFieldInitialValues(node);
  const errors = appState.docErrors[node.node_id] ?? {};

  return `
    <form class="stack" data-kind="documentation">
      ${
        node.required_evidence?.length
          ? `
            <div>
              <div class="small section-copy">Required evidence for this note</div>
              <div class="required-evidence">
                ${node.required_evidence
                  .map((item) => `<span class="evidence-pill">${escapeHtml(item)}</span>`)
                  .join("")}
              </div>
            </div>`
          : ""
      }
      ${node.fields
        .map((field) => {
          const value = draft[field.field_id] ?? "";
          const error = errors[field.field_id] ?? "";

          if (field.input_type === "single_select") {
            return `
              <div class="field">
                <label for="${escapeHtml(field.field_id)}">${escapeHtml(field.label)}</label>
                <select id="${escapeHtml(field.field_id)}" name="${escapeHtml(field.field_id)}">
                  <option value="">Select an option</option>
                  ${field.options
                    .map(
                      (option) => `
                        <option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>
                          ${escapeHtml(option)}
                        </option>`,
                    )
                    .join("")}
                </select>
                ${error ? `<div class="field-error">${escapeHtml(error)}</div>` : ""}
              </div>
            `;
          }

          return `
            <div class="field">
              <label for="${escapeHtml(field.field_id)}">${escapeHtml(field.label)}</label>
              <textarea id="${escapeHtml(field.field_id)}" name="${escapeHtml(field.field_id)}">${escapeHtml(value)}</textarea>
              ${error ? `<div class="field-error">${escapeHtml(error)}</div>` : ""}
            </div>
          `;
        })
        .join("")}
      <button class="submit-button" type="submit">Submit Documentation</button>
    </form>
  `;
}

function renderAuditNode(runtime, audit) {
  const issueMarkup = audit.issues.length
    ? audit.issues
        .map(
          (issue) => `
            <div class="stat">
              <strong>${escapeHtml(issue.rule_id)} (${escapeHtml(issue.severity)})</strong>
              <div class="small">${escapeHtml(issue.message)}</div>
            </div>`,
        )
        .join("")
    : `<div class="empty">No audit issues triggered.</div>`;

  return `
    <div class="stack">
      <div class="audit-hero tone-${escapeHtml(audit.outcome)}">
        <div class="small">Outcome</div>
        <h3 class="audit-title">${escapeHtml(audit.outcome.replaceAll("_", " "))}</h3>
        <div>${escapeHtml(audit.summary)}</div>
      </div>

      <section>
        <h3>Audit Findings</h3>
        <div class="audit-list">${issueMarkup}</div>
      </section>

      <section>
        <h3>Documentation</h3>
        <div class="detail-list">
          ${
            audit.documentationProblems.length
              ? audit.documentationProblems
                  .map((item) => `<div class="stat">${escapeHtml(item)}</div>`)
                  .join("")
              : `<div class="empty">No documentation issues recorded.</div>`
          }
        </div>
      </section>

      <section>
        <h3>Behavior Concerns</h3>
        <div class="detail-list">
          ${
            audit.behaviorConcerns.length
              ? audit.behaviorConcerns
                  .map((item) => `<div class="stat">${escapeHtml(item)}</div>`)
                  .join("")
              : `<div class="empty">No behavior concerns recorded.</div>`
          }
        </div>
      </section>

      <section>
        <h3>Missed Evidence</h3>
        <div class="detail-list">
          ${
            audit.missedEvidenceIds.length
              ? audit.missedEvidenceIds
                  .map((item) => `<div class="stat">${escapeHtml(item)}</div>`)
                  .join("")
              : `<div class="empty">No required evidence was missed.</div>`
          }
        </div>
      </section>

      <section>
        <h3>Run State</h3>
        <div class="small">Completed: ${runtime.completed ? "Yes" : "No"}</div>
      </section>
    </div>
  `;
}

function renderFlash(flash) {
  return `
    <div class="flash ${escapeHtml(flash.tone)}">
      ${flash.lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
    </div>
  `;
}

function getNodeImageSrc(scenario, node) {
  const rawSrc = resolveNodeImageSrc(scenario, node);
  if (!rawSrc) return null;

  const imageName = rawSrc.split("/").pop();
  const resolvedName = IMAGE_ALIASES[imageName] ?? imageName;
  return `./${resolvedName}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
