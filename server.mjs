import http from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { loadScenario } from "./scenarioLoader.ts";
import {
  applyEnterNodeEffects,
  createInitialRuntimeState,
  getCurrentNode,
  getNodeById,
  resolveNodeImageSrc,
  selectChoice,
  submitDocumentation,
} from "./scenarioEngine.ts";
import {
  buildDocumentationFeedback,
  evaluateDocumentationSubmission,
  getDocumentationFieldInitialValues,
  getDocumentationScoreLabel,
} from "./documentationEvaluator.ts";
import { evaluateAudit } from "./auditEvaluator.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT ?? 3000);

const IMAGE_ALIASES = {
  "img_unlabeled_barrels.jpg": "img_unlabeled_barrels Medium.jpg",
};

const sessions = new Map();
let scenario = null;
let scenarioReadyResolve;
const scenarioReady = new Promise((resolve) => {
  scenarioReadyResolve = resolve;
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/health") {
      respondText(res, 200, "ok");
      return;
    }

    if (url.pathname === "/StormSim_S1_V4_2.json") {
      await serveStaticFile(res, path.join(__dirname, "StormSim_S1_V4_2.json"), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname.startsWith("/images/")) {
      await serveImage(res, url.pathname.replace("/images/", ""));
      return;
    }

    await scenarioReady;

    if (url.pathname === "/" && req.method === "GET") {
      const session = getSession(req, res);
      renderApp(res, session);
      return;
    }

    if (url.pathname === "/actions/reset" && req.method === "POST") {
      const session = getSession(req, res);
      resetSession(session);
      redirect(res, "/");
      return;
    }

    if (url.pathname === "/actions/choice" && req.method === "POST") {
      const session = getSession(req, res);
      const form = await readForm(req);
      const choiceId = String(form.get("choice_id") ?? "");

      if (!choiceId) {
        session.flash = { tone: "warning", lines: ["No choice was selected."] };
        redirect(res, "/");
        return;
      }

      const result = selectChoice(scenario, session.state, choiceId);
      session.state = result.nextState;
      session.docDraft = {};
      session.docErrors = {};
      session.flash = buildChoiceFlash(result.dialogueResponse);
      redirect(res, "/");
      return;
    }

    if (url.pathname === "/actions/documentation" && req.method === "POST") {
      const session = getSession(req, res);
      const currentNode = getCurrentNode(scenario, session.state);

      if (!currentNode || currentNode.node_type !== "documentation") {
        session.flash = { tone: "warning", lines: ["Documentation step is no longer active."] };
        redirect(res, "/");
        return;
      }

      const form = await readForm(req);
      const values = {};
      for (const field of currentNode.fields) {
        values[field.field_id] = String(form.get(field.field_id) ?? "");
      }

      const evidenceIds = session.state.evidence_found.map((item) => item.evidence_id);
      const evaluation = evaluateDocumentationSubmission(currentNode, values, evidenceIds);
      session.docDraft[currentNode.node_id] = values;
      session.docErrors[currentNode.node_id] = evaluation.fieldErrors;

      if (Object.keys(evaluation.fieldErrors).length > 0) {
        session.flash = {
          tone: "warning",
          lines: ["Please fix the highlighted documentation fields before continuing."],
        };
        redirect(res, "/");
        return;
      }

      const submitResult = submitDocumentation(
        scenario,
        session.state,
        currentNode.node_id,
        values,
      );

      session.state = submitResult.nextState;
      session.docErrors[currentNode.node_id] = {};
      session.flash = {
        tone: getDocumentationScoreLabel(
          submitResult.allCoreFieldsCorrect,
          submitResult.missingRequiredEvidence,
        ),
        lines: buildDocumentationFeedback(currentNode, values, evidenceIds),
      };
      redirect(res, "/");
      return;
    }

    respondText(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    respondHtml(
      res,
      500,
      `<!doctype html><html><body style="font-family:sans-serif;padding:24px"><h1>Server error</h1><pre>${escapeHtml(String(error?.stack ?? error))}</pre></body></html>`,
    );
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  try {
    scenario = await loadScenario(`http://127.0.0.1:${PORT}/StormSim_S1_V4_2.json`);
    scenarioReadyResolve();
    console.log(`StormSim player running at http://127.0.0.1:${PORT}`);
  } catch (error) {
    console.error("Failed to load scenario:", error);
    process.exitCode = 1;
    server.close();
  }
});

function getSession(req, res) {
  const sid = getOrCreateSid(req, res);
  let session = sessions.get(sid);

  if (!session) {
    session = {
      id: sid,
      state: buildFreshState(),
      flash: null,
      docDraft: {},
      docErrors: {},
    };
    sessions.set(sid, session);
  }

  return session;
}

function resetSession(session) {
  session.state = buildFreshState();
  session.flash = { tone: "success", lines: ["Scenario restarted from the beginning."] };
  session.docDraft = {};
  session.docErrors = {};
}

function buildFreshState() {
  const initial = createInitialRuntimeState(scenario);
  const startNode = getNodeById(scenario, initial.current_node_id);
  return startNode ? applyEnterNodeEffects(scenario, initial, startNode) : initial;
}

function getOrCreateSid(req, res) {
  const cookieHeader = req.headers.cookie ?? "";
  const cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      }),
  );

  if (cookies.sid) {
    return cookies.sid;
  }

  const sid = randomUUID();
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

function buildChoiceFlash(dialogueResponse) {
  if (!dialogueResponse) {
    return null;
  }

  return {
    tone: "neutral",
    lines: [dialogueResponse],
  };
}

function renderApp(res, session) {
  const state = session.state;
  const node = getCurrentNode(scenario, state);

  if (!node) {
    respondHtml(res, 500, "<h1>Current node not found.</h1>");
    return;
  }

  const audit = node.node_type === "audit_result" ? evaluateAudit(scenario, state) : null;
  const imageSrc = resolveNodeImageSrc(scenario, node);
  const flash = session.flash;
  session.flash = null;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(scenario.title)} | StormSim</title>
    <style>
      :root {
        --bg: #f4efe6;
        --panel: #fffdf9;
        --line: #d7cbb9;
        --ink: #1f2d2c;
        --muted: #5d6d6b;
        --accent: #1d5c63;
        --accent-soft: #d8ebe7;
        --warn: #8a5a00;
        --warn-soft: #fff3d6;
        --ok: #1f6a43;
        --ok-soft: #dff4e8;
        --shadow: 0 20px 50px rgba(50, 41, 27, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(29, 92, 99, 0.12), transparent 28%),
          linear-gradient(180deg, #f8f3eb 0%, var(--bg) 100%);
      }
      .shell {
        max-width: 1180px;
        margin: 0 auto;
        padding: 24px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 24px;
      }
      .eyebrow {
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 12px;
        color: var(--muted);
      }
      h1 {
        margin: 0;
        font-size: clamp(32px, 6vw, 54px);
        line-height: 0.95;
      }
      .hero-meta {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .pill {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.78);
        border: 1px solid var(--line);
        font-size: 14px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
        gap: 22px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid rgba(119, 98, 64, 0.16);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .main-card {
        overflow: hidden;
      }
      .node-image {
        width: 100%;
        display: block;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        background: #e6ddd0;
      }
      .node-body {
        padding: 26px;
      }
      .node-kicker {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h2 {
        margin: 0 0 14px;
        font-size: clamp(28px, 4vw, 40px);
      }
      .context {
        font-size: 18px;
        line-height: 1.65;
        margin: 0 0 18px;
      }
      .flash {
        padding: 14px 16px;
        border-radius: 16px;
        margin-bottom: 18px;
        border: 1px solid transparent;
      }
      .flash.success {
        background: var(--ok-soft);
        border-color: rgba(31, 106, 67, 0.2);
      }
      .flash.warning {
        background: var(--warn-soft);
        border-color: rgba(138, 90, 0, 0.2);
      }
      .flash.neutral {
        background: #eef4f3;
        border-color: rgba(29, 92, 99, 0.18);
      }
      .choice-list,
      .audit-list,
      .detail-list,
      .meta-list {
        display: grid;
        gap: 12px;
      }
      .choice-form,
      .stack {
        display: grid;
        gap: 14px;
      }
      button,
      select,
      textarea {
        font: inherit;
      }
      .choice-button,
      .submit-button,
      .secondary-button {
        width: 100%;
        border: 0;
        border-radius: 18px;
        padding: 16px 18px;
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease;
      }
      .choice-button,
      .submit-button {
        background: var(--accent);
        color: white;
        box-shadow: 0 12px 24px rgba(29, 92, 99, 0.18);
        text-align: left;
      }
      .secondary-button {
        background: #efe5d8;
        color: var(--ink);
      }
      .choice-button:hover,
      .submit-button:hover,
      .secondary-button:hover {
        transform: translateY(-1px);
      }
      .field {
        display: grid;
        gap: 8px;
      }
      .field label {
        font-weight: 700;
      }
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px 14px;
        background: white;
      }
      textarea {
        min-height: 130px;
        resize: vertical;
      }
      .field-error {
        color: #9b2c2c;
        font-size: 14px;
      }
      .required-evidence {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .evidence-pill {
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 14px;
      }
      .sidebar {
        padding: 20px;
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .sidebar h3 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .stat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .stat {
        padding: 12px;
        border-radius: 16px;
        background: #f6f0e8;
        border: 1px solid var(--line);
      }
      .stat-value {
        font-size: 26px;
        font-weight: 700;
      }
      .audit-hero {
        padding: 18px;
        border-radius: 20px;
        background: ${audit ? auditToneBackground(audit.outcome) : "transparent"};
      }
      .small {
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }
      .empty {
        color: var(--muted);
        font-style: italic;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .hero {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
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
        <form method="post" action="/actions/reset">
          <button class="secondary-button" type="submit">Restart Scenario</button>
        </form>
      </header>

      <main class="layout">
        <section class="panel main-card">
          ${imageSrc ? `<img class="node-image" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(node.prompt)}">` : ""}
          <div class="node-body">
            <p class="node-kicker">${escapeHtml(node.node_type.replace("_", " "))}</p>
            <h2>${escapeHtml(node.prompt)}</h2>
            <p class="context">${escapeHtml(node.context)}</p>
            ${flash ? renderFlash(flash) : ""}
            ${node.node_type === "documentation"
              ? renderDocumentationNode(node, session)
              : node.node_type === "audit_result"
                ? renderAuditNode(node, state, audit)
                : renderStandardNode(node)}
          </div>
        </section>

        <aside class="panel sidebar">
          <section>
            <h3>Score</h3>
            <div class="stat-grid">
              ${Object.entries(state.score)
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
              ${state.evidence_found.length
                ? state.evidence_found
                    .map(
                      (item) => `
                        <div class="stat">
                          <strong>${escapeHtml(item.label ?? item.evidence_id)}</strong>
                          <div class="small">${escapeHtml(item.evidence_id)}</div>
                        </div>`,
                    )
                    .join("")
                : `<div class="empty">No evidence found yet.</div>`}
            </div>
          </section>

          <section>
            <h3>Behavior Tags</h3>
            <div class="meta-list">
              ${state.behavior_tags.length
                ? state.behavior_tags
                    .map(
                      (tag) => `
                        <div class="stat">
                          <strong>${escapeHtml(tag)}</strong>
                          <div class="small">${escapeHtml(scenario.behavior_tag_definitions?.[tag] ?? "Tracked by runtime state.")}</div>
                        </div>`,
                    )
                    .join("")
                : `<div class="empty">No behavior concerns recorded.</div>`}
            </div>
          </section>

          <section>
            <h3>Visited Nodes</h3>
            <div class="small">${escapeHtml(state.visited_nodes.join(" -> "))}</div>
          </section>
        </aside>
      </main>
    </div>
  </body>
</html>`;

  respondHtml(res, 200, html);
}

function renderStandardNode(node) {
  return `
    <div class="choice-list">
      ${(node.choices ?? [])
        .map(
          (choice) => `
            <form class="choice-form" method="post" action="/actions/choice">
              <input type="hidden" name="choice_id" value="${escapeHtml(choice.choice_id)}">
              <button class="choice-button" type="submit">${escapeHtml(choice.text)}</button>
            </form>`,
        )
        .join("")}
    </div>
  `;
}

function renderDocumentationNode(node, session) {
  const draft = session.docDraft[node.node_id] ?? getDocumentationFieldInitialValues(node);
  const errors = session.docErrors[node.node_id] ?? {};

  return `
    <form class="stack" method="post" action="/actions/documentation">
      ${node.required_evidence?.length
        ? `
          <div>
            <div class="small" style="margin-bottom:8px">Required evidence for this note</div>
            <div class="required-evidence">
              ${node.required_evidence
                .map((item) => `<span class="evidence-pill">${escapeHtml(item)}</span>`)
                .join("")}
            </div>
          </div>`
        : ""}
      ${node.fields
        .map((field) => {
          const error = errors[field.field_id];
          const value = draft[field.field_id] ?? "";

          if (field.input_type === "single_select") {
            return `
              <div class="field">
                <label for="${escapeHtml(field.field_id)}">${escapeHtml(field.label)}</label>
                <select id="${escapeHtml(field.field_id)}" name="${escapeHtml(field.field_id)}">
                  <option value="">Select an option</option>
                  ${field.options
                    .map(
                      (option) => `
                        <option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`,
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

function renderAuditNode(node, state, audit) {
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
      <div class="audit-hero">
        <div class="small">Outcome</div>
        <h3 style="margin:8px 0 10px;font-size:28px">${escapeHtml(audit.outcome.replaceAll("_", " "))}</h3>
        <div>${escapeHtml(audit.summary)}</div>
      </div>

      <section>
        <h3>Audit Findings</h3>
        <div class="audit-list">${issueMarkup}</div>
      </section>

      <section>
        <h3>Documentation</h3>
        <div class="detail-list">
          ${audit.documentationProblems.length
            ? audit.documentationProblems.map((item) => `<div class="stat">${escapeHtml(item)}</div>`).join("")
            : `<div class="empty">No documentation issues recorded.</div>`}
        </div>
      </section>

      <section>
        <h3>Behavior Concerns</h3>
        <div class="detail-list">
          ${audit.behaviorConcerns.length
            ? audit.behaviorConcerns.map((item) => `<div class="stat">${escapeHtml(item)}</div>`).join("")
            : `<div class="empty">No behavior concerns recorded.</div>`}
        </div>
      </section>

      <section>
        <h3>Missed Evidence</h3>
        <div class="detail-list">
          ${audit.missedEvidenceIds.length
            ? audit.missedEvidenceIds.map((item) => `<div class="stat">${escapeHtml(item)}</div>`).join("")
            : `<div class="empty">No required evidence was missed.</div>`}
        </div>
      </section>

      <section>
        <h3>Run State</h3>
        <div class="small">Completed: ${state.completed ? "Yes" : "No"}</div>
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

async function serveImage(res, imageName) {
  const resolvedName = IMAGE_ALIASES[imageName] ?? imageName;
  const imagePath = path.join(__dirname, resolvedName);

  if (!existsSync(imagePath)) {
    respondText(res, 404, "Image not found");
    return;
  }

  const contentType =
    resolvedName.endsWith(".png") ? "image/png" :
    resolvedName.endsWith(".jpg") || resolvedName.endsWith(".jpeg") ? "image/jpeg" :
    "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(imagePath).pipe(res);
}

async function serveStaticFile(res, filePath, contentType) {
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

async function readForm(req) {
  const body = await readBody(req);
  return new URLSearchParams(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function respondHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function respondText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function auditToneBackground(outcome) {
  switch (outcome) {
    case "exemplary_completion":
      return "linear-gradient(135deg, rgba(31,106,67,0.16), rgba(223,244,232,0.9))";
    case "pass_with_remediation":
      return "linear-gradient(135deg, rgba(138,90,0,0.14), rgba(255,243,214,0.9))";
    case "soft_fail":
      return "linear-gradient(135deg, rgba(155,44,44,0.12), rgba(255,236,236,0.92))";
    case "critical_fail":
      return "linear-gradient(135deg, rgba(110,22,22,0.18), rgba(255,226,226,0.96))";
    default:
      return "transparent";
  }
}
