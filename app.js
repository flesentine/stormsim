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

const SCENARIO_PATH = "./StormSim_S1_V4_3.json?v=20260413c";
const IMAGE_VERSION = "20260413c";

const appState = {
  scenario: null,
  runtime: null,
  flash: null,
  lastDialogueResponse: null,
  docDraft: {},
  docErrors: {},
  mode: "play",
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
  const scenario = await loadScenario(SCENARIO_PATH);
  appState.scenario = scenario;
  appState.mode = scenario.ui_modes?.default_mode ?? "play";
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
  appState.flash = appState.mode === "trainer"
    ? {
        tone: "success",
        lines: ["Trainer Mode active. Runtime scoring and coaching details are visible."],
      }
    : null;
  appState.lastDialogueResponse = null;
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

  if (action === "set-mode") {
    const nextMode = button.dataset.mode;
    if (!nextMode || nextMode === appState.mode) return;
    appState.mode = nextMode;
    appState.flash = {
      tone: "success",
      lines: [
        nextMode === "trainer"
          ? "Trainer Mode enabled. Decision rationale and coaching details are now visible."
          : "Play Mode enabled. Live scoring and debug-style detail are now minimized.",
      ],
    };
    render();
    return;
  }

  if (action === "choice") {
    const choiceId = button.dataset.choiceId;
    if (!choiceId) return;
    const currentNode = getCurrentNode(appState.scenario, appState.runtime);
    const selectedChoice = currentNode?.choices?.find((choice) => choice.choice_id === choiceId) ?? null;

    const result = selectChoice(appState.scenario, appState.runtime, choiceId);
    appState.runtime = result.nextState;
    appState.flash = buildChoiceFlash(result);
    appState.lastDialogueResponse = shouldCarryDialogueResponse(selectedChoice, result.nextNode)
      ? result.dialogueResponse ?? null
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
      lines: ["Please complete the note before continuing."],
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
  appState.flash = buildDocumentationFlash(node, values, evidenceIds, result);
  appState.lastDialogueResponse = null;
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
  const imageClass = getNodeImageClass(node);
  const modeConfig = getModeConfig(scenario, appState.mode);
  const hasStarted =
    runtime.selected_choice_ids.length > 0 ||
    Object.keys(runtime.documentation_results ?? {}).length > 0;

  root.innerHTML = `
    <div class="shell">
      <header class="hero panel ${hasStarted ? "hero-compact" : ""}">
        <div>
          <p class="eyebrow">StormSim Scenario Player</p>
          <h1>${escapeHtml(scenario.title)}</h1>
          <p class="hero-subtitle">Field inspection simulation with branching dialogue, evidence capture, documentation, and debrief review.</p>
          <div class="hero-meta">
            <span class="pill">${escapeHtml(scenario.difficulty)}</span>
            <span class="pill">${scenario.estimated_minutes} minutes</span>
            <span class="pill">${escapeHtml(getNodeBadgeLabel(node))}</span>
          </div>
        </div>
        <div class="hero-actions">
          <div class="mode-toggle" role="tablist" aria-label="View mode">
            ${renderModeButton("play", "Play Mode")}
            ${renderModeButton("trainer", "Trainer Mode")}
          </div>
          <button class="secondary-button" data-action="reset" type="button">Restart Scenario</button>
        </div>
      </header>

      <main class="layout">
        <section class="panel main-card">
          ${imageSrc ? `<img class="node-image ${escapeHtml(imageClass)}" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(node.prompt)}">` : ""}
          <div class="node-body">
            <div class="section-label-row">
              <p class="node-kicker">${escapeHtml(getNodeTypeLabel(node))}</p>
              <span class="step-pill">${escapeHtml(getNodeBadgeLabel(node))}</span>
            </div>
            ${renderTransitionDialogue(node)}
            ${renderNodeHeadline(node, runtime)}
            <p class="context">${escapeHtml(node.context)}</p>
            ${appState.flash ? renderFlash(appState.flash) : ""}
            ${
              node.node_type === "documentation"
                ? renderDocumentationNode(node, modeConfig)
                : node.node_type === "audit_result"
                  ? renderAuditNode(runtime, audit, modeConfig)
                  : renderStandardNode(node, modeConfig)
            }
          </div>
        </section>

        <aside class="panel sidebar ${appState.mode === "play" ? "sidebar-play" : "sidebar-trainer"}">
          ${renderSidebar(runtime, audit, modeConfig, node)}
        </aside>
      </main>
    </div>
  `;
}

function renderModeButton(mode, label) {
  return `
    <button
      class="mode-button ${appState.mode === mode ? "is-active" : ""}"
      data-action="set-mode"
      data-mode="${mode}"
      type="button"
      role="tab"
      aria-selected="${appState.mode === mode}"
    >
      ${label}
    </button>
  `;
}

function renderSidebar(runtime, audit, modeConfig, node) {
  const sections = [];
  const evidenceItems = runtime.evidence_found.length
    ? runtime.evidence_found
        .map(
          (item) => `
            <div class="notebook-entry">
              <strong>${escapeHtml(getEvidenceDisplayLabel(item))}</strong>
              <div class="small">${escapeHtml(getEvidenceMeta(item))}</div>
            </div>`,
        )
        .join("")
    : `<div class="empty">No field notes yet.</div>`;

  if (appState.mode === "play") {
    sections.push(`
      <details class="sidebar-section sidebar-disclosure support-card" ${runtime.evidence_found.length ? "open" : ""}>
        <summary>Inspection notebook</summary>
        <div class="small">Anything you confirm during the walkthrough will appear here.</div>
        <div class="notebook-list compact">${evidenceItems}</div>
      </details>
    `);

    if (node.node_type === "documentation") {
      sections.push(`
        <details class="sidebar-section sidebar-disclosure" open>
          <summary>What to capture</summary>
          <div class="small">Write what you observed, why it matters, and what follow-up makes sense.</div>
        </details>
      `);
    }

    if (audit) {
      sections.push(`
        <details class="sidebar-section sidebar-disclosure">
          <summary>Walkthrough path</summary>
          <div class="small">${escapeHtml(runtime.visited_nodes.map((nodeId) => getVisitedNodeLabel(appState.scenario, nodeId)).join(" -> "))}</div>
        </details>
      `);
    }

    return sections.join("");
  }

  if (modeConfig.show_live_score) {
    sections.push(`
      <details class="sidebar-section sidebar-disclosure" open>
        <summary>Coaching snapshot</summary>
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
      </details>
    `);
  }

  sections.push(`
    <details class="sidebar-section sidebar-disclosure" open>
      <summary>Notebook</summary>
      <div class="notebook-list">${evidenceItems}</div>
    </details>
  `);

  if (modeConfig.show_behavior_tags) {
    sections.push(`
      <details class="sidebar-section sidebar-disclosure">
        <summary>Coaching notes</summary>
        <div class="detail-list">
          ${
            runtime.behavior_tags.length
              ? runtime.behavior_tags
                  .map(
                    (tag) => `
                      <div class="stat">
                        <strong>${escapeHtml(humanizeBehaviorTag(tag))}</strong>
                        <div class="small">${escapeHtml(appState.scenario.behavior_tag_definitions?.[tag] ?? "Tracked by runtime state.")}</div>
                      </div>`,
                  )
                  .join("")
              : `<div class="empty">No coaching notes recorded yet.</div>`
          }
        </div>
      </details>
    `);
  }

  if (modeConfig.show_visited_nodes) {
    sections.push(`
      <details class="sidebar-section sidebar-disclosure">
        <summary>Walkthrough path</summary>
        <div class="small">${escapeHtml(runtime.visited_nodes.map((nodeId) => getVisitedNodeLabel(appState.scenario, nodeId)).join(" -> "))}</div>
      </details>
    `);
  }

  if (audit && appState.mode === "trainer") {
    sections.push(`
      <details class="sidebar-section sidebar-disclosure" open>
        <summary>Review focus</summary>
        <div class="small">Documentation level: ${escapeHtml(getDocumentationLevelLabel(audit.documentationLevel))}</div>
        <div class="small">This fuller explanation appears in the debrief below.</div>
      </details>
    `);
  }

  return sections.join("");
}

function renderStandardNode(node, modeConfig) {
  return `
    <section class="stack">
      <div class="action-header">
        <div class="action-title">Choose your next move</div>
        <div class="small">${
          appState.mode === "trainer"
            ? "Make the decision you would coach in the field. Brief guidance appears after each choice."
            : "Respond as you would in the field. Detailed coaching comes later."
        }</div>
      </div>
      <div class="choice-list">
        ${(node.choices ?? [])
          .map(
            (choice, index) => {
              const copy = splitChoiceCopy(choice.text);
              return `
              <button class="choice-button" data-action="choice" data-choice-id="${escapeHtml(choice.choice_id)}" type="button">
                <span class="choice-index">${String(index + 1).padStart(2, "0")}</span>
                <span class="choice-copy">
                  <span class="choice-text">${escapeHtml(copy.primary)}</span>
                  ${copy.secondary ? `<span class="choice-subtext">${escapeHtml(copy.secondary)}</span>` : ""}
                </span>
                <span class="choice-arrow">Choose</span>
              </button>`;
            },
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderNodeHeadline(node, runtime) {
  if (node.node_type === "dialogue") {
    const isOpeningBeat = runtime.visited_nodes.length <= 2;
    return `
      <div class="dialogue-block ${isOpeningBeat ? "dialogue-block-opening" : "dialogue-block-compact"}">
        <div class="speaker-label">Owner</div>
        <blockquote class="dialogue-quote ${isOpeningBeat ? "dialogue-quote-opening" : "dialogue-quote-compact"}">${escapeHtml(stripSpeakerPrefix(node.prompt))}</blockquote>
      </div>
    `;
  }

  return `<h2>${escapeHtml(node.prompt)}</h2>`;
}

function renderTransitionDialogue(node) {
  if (!appState.lastDialogueResponse || node?.node_type === "dialogue") {
    return "";
  }

  return `
    <div class="transition-dialogue">
      <div class="transition-label">Owner says</div>
      <div class="transition-quote">${escapeHtml(stripSpeakerPrefix(appState.lastDialogueResponse))}</div>
    </div>
  `;
}

function shouldCarryDialogueResponse(choice, nextNode) {
  if (!choice?.dialogue_response) return false;
  if (nextNode?.node_type === "dialogue") return false;
  if (nextNode?.node_type === "audit_result") return false;

  const text = String(choice.text ?? "").toLowerCase();
  return [
    "ask ",
    "ask the owner",
    "ask a ",
    "tell the owner",
    "tell the owner this",
    "summarize",
    "explain",
    "introduce yourself",
    "acknowledge",
    "state that",
  ].some((phrase) => text.includes(phrase));
}

function renderDocumentationNode(node, modeConfig) {
  const draft = appState.docDraft[node.node_id] ?? getDocumentationFieldInitialValues(node);
  const errors = appState.docErrors[node.node_id] ?? {};

  return `
    <form class="stack" data-kind="documentation">
      <div class="doc-intro">
        <div class="doc-intro-title">Write the note that supports follow-up</div>
        <div class="small">Capture the condition, why it matters, and what should happen next. Aim for a note another inspector could act on.</div>
      </div>
      ${
        modeConfig.show_required_evidence_checklist && node.required_evidence_labels?.length
          ? `
            <div>
              <div class="small section-copy">Key observations to support this note</div>
              <div class="required-evidence">
                ${node.required_evidence_labels
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
          const label = field.field_id === "notes"
            ? modeConfig.player_notes_label ?? field.label
            : field.label;

          if (field.input_type === "single_select") {
            return `
              <div class="field">
                <label for="${escapeHtml(field.field_id)}">${escapeHtml(label)}</label>
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
              <label for="${escapeHtml(field.field_id)}">${escapeHtml(label)}</label>
              <textarea id="${escapeHtml(field.field_id)}" name="${escapeHtml(field.field_id)}" placeholder="Capture what you observed and why it matters for follow-up.">${escapeHtml(value)}</textarea>
              ${error ? `<div class="field-error">${escapeHtml(error)}</div>` : ""}
            </div>
          `;
        })
        .join("")}
      <button class="submit-button" type="submit">Submit Documentation</button>
    </form>
  `;
}

function renderAuditNode(runtime, audit, modeConfig) {
  const issueMarkup = audit.issues.length
    ? audit.issues
        .map(
          (issue) => `
            <div class="stat">
              <strong>${escapeHtml(getAuditIssueLabel(issue.rule_id))}${appState.mode === "trainer" ? ` (${escapeHtml(toTitleCase(issue.severity))})` : ""}</strong>
              <div class="small">${escapeHtml(issue.message)}</div>
            </div>`,
        )
        .join("")
    : `<div class="empty">No audit issues triggered.</div>`;

  const strengths = buildDebriefStrengths(runtime, audit);
  const followUps = buildDebriefFollowUps(audit);

  return `
    <div class="stack">
      <div class="audit-hero tone-${escapeHtml(audit.outcome)}">
        <div class="small">Outcome</div>
        <h3 class="audit-title">${escapeHtml(getAuditOutcomeLabel(audit.outcome))}</h3>
        <div>${escapeHtml(audit.summary)}</div>
      </div>

      <section>
        <h3>What went well</h3>
        <div class="detail-list">
          ${strengths.map((item) => `<div class="stat">${escapeHtml(item)}</div>`).join("")}
        </div>
      </section>

      <section>
        <h3>What needed follow-up</h3>
        <div class="audit-list">
          ${
            followUps.length
              ? followUps.map((item) => `<div class="stat">${escapeHtml(item)}</div>`).join("")
              : `<div class="empty">No major follow-up gaps stood out in this run.</div>`
          }
        </div>
      </section>

      <section>
        <h3>Documentation</h3>
        <div class="detail-list">
          ${
            audit.documentationProblems.length
              ? audit.documentationProblems
                  .map((item) => `<div class="stat">${escapeHtml(item)}</div>`)
                  .join("")
              : `<div class="empty">${
                appState.mode === "trainer"
                  ? `Documentation reached ${escapeHtml(getDocumentationLevelLabel(audit.documentationLevel)).toLowerCase()}.`
                  : "Documentation did not raise any major debrief concerns."
              }</div>`
          }
        </div>
      </section>

      <section>
        <h3>Tone and judgment</h3>
        <div class="detail-list">
          ${
            audit.behaviorConcerns.length
              ? audit.behaviorConcerns
                  .map((item) => `<div class="stat">${escapeHtml(item)}</div>`)
                  .join("")
              : `<div class="empty">No major tone or judgment concerns stood out.</div>`
          }
        </div>
      </section>

      ${
        modeConfig.show_live_score
          ? `
            <details class="sidebar-section sidebar-disclosure" open>
              <summary>Trainer detail</summary>
              <h3>Trainer detail</h3>
              <div class="small">Documentation level: ${escapeHtml(getDocumentationLevelLabel(audit.documentationLevel))}</div>
              <div class="small">Final score: ${escapeHtml(String(getScoreTotal(runtime.score)))}</div>
              <div class="audit-list">${issueMarkup}</div>
            </details>
          `
          : ""
      }
    </div>
  `;
}

function renderFlash(flash) {
  return `
    <div class="flash ${escapeHtml(flash.tone)}">
      ${appState.mode === "trainer" ? `<div class="flash-label">Coach note</div>` : ""}
      ${flash.lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
    </div>
  `;
}

function buildChoiceFlash(result) {
  if (appState.mode !== "trainer") {
    return null;
  }

  const lines = [];
  const scoreNotes = formatScoreDelta(result.scoreDelta);
  if (scoreNotes.length) {
    lines.push(`Coaching signal: ${scoreNotes.join(", ")}.`);
  }

  if (result.behaviorTagsApplied?.length) {
    lines.push(
      `Pattern to notice: ${result.behaviorTagsApplied.map(humanizeBehaviorTag).join(", ")}.`,
    );
  }

  return lines.length ? { tone: "neutral", lines } : null;
}

function buildDocumentationFlash(node, values, evidenceIds, result) {
  if (appState.mode === "trainer") {
    return {
      tone: getDocumentationScoreLabel(result.completionLevel),
      lines: buildDocumentationFeedback(node, values, evidenceIds),
    };
  }

  const lines = [];

  if (result.completionLevel === "preferred_or_acceptable") {
    lines.push("Your note is solid enough to support follow-up.");
  } else if (result.completionLevel === "partial_credit") {
    lines.push("Your note captures the issue, but it could be stronger.");
  } else {
    lines.push("Your note was saved, but it may not fully support follow-up.");
  }

  return {
    tone: getDocumentationScoreLabel(result.completionLevel),
    lines,
  };
}

function getModeConfig(scenario, mode) {
  return scenario.ui_modes?.[`${mode}_mode`] ?? {};
}

function getModeSummary(modeConfig) {
  return modeConfig.feedback_style ?? "Scenario mode active.";
}

function getNodeImageSrc(scenario, node) {
  const rawSrc = resolveNodeImageSrc(scenario, node);
  if (!rawSrc) return null;

  const imageName = rawSrc.split("/").pop();
  const resolvedName = IMAGE_ALIASES[imageName] ?? imageName;
  return `./${resolvedName}?v=${IMAGE_VERSION}`;
}

function getNodeImageClass(node) {
  switch (node.image_id) {
    case "img_owner_blocking_entry.jpg":
      return "node-image-portrait";
    case "img_shop_floor_subtle.jpg":
      return "node-image-ambiguous-floor";
    case "img_tarp_area.jpg":
      return "node-image-ambiguous-storage";
    default:
      return "";
  }
}

function getNodeBadgeLabel(node) {
  if (node.node_type === "audit_result") {
    return "Debrief";
  }

  if (node.node_type === "documentation") {
    return "Documentation";
  }

  return humanizeNodeId(node.node_id);
}

function getNodeTypeLabel(node) {
  const labels = {
    dialogue: "Conversation",
    inspection: "Inspection",
    decision: "Decision point",
    documentation: "Write-up",
    audit_result: "Debrief",
  };

  return labels[node.node_type] ?? humanizeToken(node.node_type);
}

function getVisitedNodeLabel(scenario, nodeId) {
  const node = getNodeById(scenario, nodeId);
  if (!node) return humanizeNodeId(nodeId);
  if (node.node_type === "audit_result") return "Debrief";
  if (node.node_type === "documentation") return "Documentation";
  return humanizeNodeId(node.node_id);
}

function getEvidenceCatalogLabel(scenario, evidenceId) {
  const match = scenario.evidence_catalog?.find((item) => item.evidence_id === evidenceId);
  return match?.label ?? humanizeToken(evidenceId.replace(/^evidence_/, ""));
}

function getEvidenceDisplayLabel(item) {
  return item.label ?? humanizeToken(item.evidence_id.replace(/^evidence_/, ""));
}

function getEvidenceMeta(item) {
  const parts = [];

  if (item.severity) parts.push(`${humanizeToken(item.severity)} severity`);
  if (item.type) parts.push(humanizeToken(item.type));

  return parts.join(" • ") || "Inspection evidence";
}

function humanizeNodeId(nodeId) {
  const labels = {
    N1_arrival: "Arrival",
    N2_entry: "Entry",
    N2_entry_tense: "Tense entry",
    N3_floor: "Initial floor clue",
    N3_recovery_hint: "Recovery hint",
    N3a_drain: "Drain check",
    N3b_violation: "Drain finding",
    N_doc_1: "Documentation",
    N4_storage: "Storage area",
    N4_return_check: "Return check",
    N4a_hidden: "Hidden storage issue",
    N5_exit: "Closeout",
    N6_audit: "Debrief",
  };

  return labels[nodeId] ?? humanizeToken(nodeId.replace(/^N\d+[a-z]?_?/i, ""));
}

function humanizeToken(value) {
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getAuditOutcomeLabel(outcome) {
  const labels = {
    exemplary_completion: "Exemplary Completion",
    pass_with_remediation: "Pass With Remediation",
    soft_fail: "Needs Improvement",
    critical_fail: "Critical Fail",
  };

  return labels[outcome] ?? humanizeToken(outcome);
}

function getAuditIssueLabel(ruleId) {
  const labels = {
    A1: "Drain Issue Not Fully Verified",
    A2: "Drain Documentation Too Weak",
    A3: "Storage Area Follow-up Missed",
    A4: "Premature Escalation",
  };

  return labels[ruleId] ?? ruleId;
}

function humanizeBehaviorTag(tag) {
  const labels = {
    premature_escalation: "Escalation moved too quickly",
    passive_avoidance: "Reasonable follow-up was avoided",
    missed_followup: "Suspicious area was not followed through",
  };

  return labels[tag] ?? humanizeToken(tag);
}

function splitChoiceCopy(text) {
  const value = String(text).trim();
  const commaIndex = value.indexOf(",");

  if (commaIndex > 18) {
    return {
      primary: value.slice(0, commaIndex),
      secondary: value.slice(commaIndex + 1).trim(),
    };
  }

  const sentenceMatch = value.match(/^(.+?[.!?])\s+(.+)$/);
  if (sentenceMatch) {
    return {
      primary: sentenceMatch[1].trim(),
      secondary: sentenceMatch[2].trim(),
    };
  }

  const andIndex = value.indexOf(" and ");
  if (andIndex > 24) {
    return {
      primary: value.slice(0, andIndex),
      secondary: `Then ${value.slice(andIndex + 5)}`,
    };
  }

  return { primary: value, secondary: "" };
}

function getDocumentationLevelLabel(level) {
  const labels = {
    preferred_or_acceptable: "Preferred or Acceptable",
    partial_credit: "Partial Credit",
    otherwise: "Insufficient",
  };

  return labels[level] ?? humanizeToken(level);
}

function buildDebriefStrengths(runtime, audit) {
  const items = [];

  if (!audit.missedEvidenceIds.length) {
    items.push("You followed the inspection through without missing the required evidence.");
  }

  if (!audit.documentationProblems.length) {
    items.push("Your documentation was strong enough to support follow-up.");
  }

  if (!audit.behaviorConcerns.length) {
    items.push("Your tone stayed professional and did not create extra resistance.");
  }

  if (!items.length) {
    items.push("You completed the walkthrough and created a record the debrief could evaluate.");
  }

  return items;
}

function buildDebriefFollowUps(audit) {
  const items = [];

  items.push(...audit.issues.map((issue) => issue.message));
  items.push(...audit.documentationProblems);
  items.push(...audit.behaviorConcerns);

  if (audit.missedEvidenceIds.length) {
    items.push(
      ...audit.missedEvidenceIds.map(
        (item) => `Missed evidence: ${getEvidenceCatalogLabel(appState.scenario, item)}.`,
      ),
    );
  }

  return [...new Set(items)];
}

function formatScoreDelta(scoreDelta = {}) {
  return Object.entries(scoreDelta)
    .filter(([, value]) => value)
    .map(([label, value]) => `${humanizeToken(label)} ${value > 0 ? "+" : ""}${value}`);
}

function getScoreTotal(score) {
  return Object.values(score).reduce((sum, value) => sum + value, 0);
}

function toTitleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function stripSpeakerPrefix(value) {
  return String(value).replace(/^[A-Za-z ]+:\s*/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
