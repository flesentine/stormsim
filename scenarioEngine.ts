// scenarioEngine.ts
// Core runtime state + transition logic for StormSim MVP.

export type ScoreCategory =
  | "compliance"
  | "communication"
  | "detection"
  | "risk"
  | "conduct";

export type ScoreState = Record<ScoreCategory, number>;

export interface EvidenceCatalogItem {
  evidence_id: string;
  type: string;
  label: string;
  severity: string;
  is_required_for_audit: boolean;
}

export interface AwardedEvidenceRef {
  evidence_id: string;
  source_node_id: string;
}

export interface RuntimeEvidence extends AwardedEvidenceRef {
  type?: string;
  label?: string;
  severity?: string;
  is_required_for_audit?: boolean;
}

export interface Choice {
  choice_id: string;
  text: string;
  dialogue_response?: string;
  score_delta?: Partial<ScoreState>;
  behavior_tags_on_select?: string[];
  next_node: string | null;
}

export interface DocumentationField {
  field_id: string;
  label: string;
  input_type: "single_select" | "text";
  options?: string[];
  correct_value?: string;
  scoring_rules?: {
    must_include_any?: string[];
  };
}

export interface DocumentationScoring {
  all_core_fields_correct?: Partial<ScoreState>;
  otherwise?: Partial<ScoreState>;
}

export interface DocumentationNode {
  node_id: string;
  node_type: "documentation";
  image_id?: string;
  context: string;
  prompt: string;
  required_evidence?: string[];
  fields: DocumentationField[];
  scoring?: DocumentationScoring;
  behavior_tags_on_fail?: string[];
  next_node: string | null;
}

export interface AuditRule {
  rule_id: string;
  condition: string;
  message: string;
}

export interface CompletionLogic {
  critical_fail_conditions?: string[];
  pass_with_remediation_conditions?: string[];
  exemplary_completion_conditions?: string[];
}

export interface BaseNode {
  node_id: string;
  node_type:
    | "dialogue"
    | "inspection"
    | "decision"
    | "documentation"
    | "audit_result";
  image_id?: string;
  context: string;
  prompt: string;
  next_node?: string | null;
}

export interface StandardNode extends BaseNode {
  choices?: Choice[];
  evidence_awarded_on_enter?: AwardedEvidenceRef[];
}

export interface AuditNode extends BaseNode {
  node_type: "audit_result";
  audit_rules?: AuditRule[];
  completion_logic?: CompletionLogic;
  next_node: null;
}

export type ScenarioNode = StandardNode | DocumentationNode | AuditNode;

export interface Scenario {
  scenario_id: string;
  title: string;
  difficulty: string;
  skills: string[];
  estimated_minutes: number;
  regional_ruleset: string;
  start_node_id: string;
  image_base_path?: string;
  images?: Array<{
    image_id: string;
    purpose: string;
  }>;
  behavior_tag_definitions?: Record<string, string>;
  evidence_catalog?: EvidenceCatalogItem[];
  state_model_reference?: {
    score_categories: ScoreCategory[];
    tracked_state_keys: string[];
  };
  nodes: ScenarioNode[];
}

export interface DocumentationResults {
  [nodeId: string]: {
    values: Record<string, string>;
    allCoreFieldsCorrect: boolean;
    missingRequiredEvidence: string[];
  };
}

export interface RuntimeState {
  scenario_id: string;
  current_node_id: string;
  visited_nodes: string[];
  score: ScoreState;
  evidence_found: RuntimeEvidence[];
  behavior_tags: string[];
  audit_flags: string[];
  completed: boolean;
  documentation_results: DocumentationResults;
  selected_choice_ids: string[];
}

export interface ChoiceTransitionResult {
  nextState: RuntimeState;
  dialogueResponse?: string;
  nextNode: ScenarioNode | null;
}

export interface DocumentationSubmitResult {
  nextState: RuntimeState;
  nextNode: ScenarioNode | null;
  allCoreFieldsCorrect: boolean;
  missingRequiredEvidence: string[];
}

const DEFAULT_SCORE: ScoreState = {
  compliance: 0,
  communication: 0,
  detection: 0,
  risk: 0,
  conduct: 0,
};

export function createInitialRuntimeState(scenario: Scenario): RuntimeState {
  return {
    scenario_id: scenario.scenario_id,
    current_node_id: scenario.start_node_id,
    visited_nodes: [scenario.start_node_id],
    score: { ...DEFAULT_SCORE },
    evidence_found: [],
    behavior_tags: [],
    audit_flags: [],
    completed: false,
    documentation_results: {},
    selected_choice_ids: [],
  };
}

export function getNodeById(
  scenario: Scenario,
  nodeId: string | null | undefined,
): ScenarioNode | null {
  if (!nodeId) return null;
  return scenario.nodes.find((node) => node.node_id === nodeId) ?? null;
}

export function resolveNodeImageSrc(
  scenario: Scenario,
  node: ScenarioNode,
): string | null {
  if (!node.image_id) return null;
  const basePath = scenario.image_base_path ?? "/images/";
  return `${basePath}${node.image_id}`;
}

export function applyEnterNodeEffects(
  scenario: Scenario,
  state: RuntimeState,
  node: ScenarioNode,
): RuntimeState {
  let nextState = cloneRuntimeState(state);

  if (!nextState.visited_nodes.includes(node.node_id)) {
    nextState.visited_nodes.push(node.node_id);
  }

  if ("evidence_awarded_on_enter" in node && node.evidence_awarded_on_enter?.length) {
    for (const awarded of node.evidence_awarded_on_enter) {
      nextState = addEvidence(scenario, nextState, awarded);
    }
  }

  return nextState;
}

export function selectChoice(
  scenario: Scenario,
  state: RuntimeState,
  choiceId: string,
): ChoiceTransitionResult {
  const currentNode = getNodeById(scenario, state.current_node_id);

  if (!currentNode) {
    throw new Error(`Current node "${state.current_node_id}" not found.`);
  }

  if (currentNode.node_type === "documentation") {
    throw new Error(
      `Node "${currentNode.node_id}" is a documentation node and must be submitted via submitDocumentation().`,
    );
  }

  const choices = "choices" in currentNode ? currentNode.choices ?? [] : [];
  const choice = choices.find((c) => c.choice_id === choiceId);

  if (!choice) {
    throw new Error(
      `Choice "${choiceId}" not found on node "${currentNode.node_id}".`,
    );
  }

  let nextState = cloneRuntimeState(state);
  nextState.selected_choice_ids.push(choice.choice_id);

  nextState.score = applyScoreDelta(nextState.score, choice.score_delta);

  if (choice.behavior_tags_on_select?.length) {
    nextState.behavior_tags = mergeUniqueStrings(
      nextState.behavior_tags,
      choice.behavior_tags_on_select,
    );
  }

  if (!choice.next_node) {
    nextState.completed = true;
    return {
      nextState,
      dialogueResponse: choice.dialogue_response,
      nextNode: null,
    };
  }

  const nextNode = getNodeById(scenario, choice.next_node);
  if (!nextNode) {
    throw new Error(`Next node "${choice.next_node}" not found.`);
  }

  nextState.current_node_id = nextNode.node_id;
  nextState = applyEnterNodeEffects(scenario, nextState, nextNode);

  if (nextNode.node_type === "audit_result") {
    nextState.completed = true;
  }

  return {
    nextState,
    dialogueResponse: choice.dialogue_response,
    nextNode,
  };
}

export function submitDocumentation(
  scenario: Scenario,
  state: RuntimeState,
  nodeId: string,
  values: Record<string, string>,
): DocumentationSubmitResult {
  const node = getNodeById(scenario, nodeId);

  if (!node || node.node_type !== "documentation") {
    throw new Error(`Documentation node "${nodeId}" not found.`);
  }

  let nextState = cloneRuntimeState(state);

  const missingRequiredEvidence =
    node.required_evidence?.filter(
      (requiredId) =>
        !nextState.evidence_found.some((e) => e.evidence_id === requiredId),
    ) ?? [];

  const allCoreFieldsCorrect = areDocumentationCoreFieldsCorrect(node, values);

  nextState.documentation_results[node.node_id] = {
    values: { ...values },
    allCoreFieldsCorrect,
    missingRequiredEvidence,
  };

  const scoring = node.scoring ?? {};
  if (allCoreFieldsCorrect && missingRequiredEvidence.length === 0) {
    nextState.score = applyScoreDelta(
      nextState.score,
      scoring.all_core_fields_correct,
    );
  } else {
    nextState.score = applyScoreDelta(nextState.score, scoring.otherwise);
    nextState.behavior_tags = mergeUniqueStrings(
      nextState.behavior_tags,
      node.behavior_tags_on_fail ?? [],
    );
  }

  if (!node.next_node) {
    nextState.completed = true;
    return {
      nextState,
      nextNode: null,
      allCoreFieldsCorrect,
      missingRequiredEvidence,
    };
  }

  const nextNode = getNodeById(scenario, node.next_node);
  if (!nextNode) {
    throw new Error(`Next node "${node.next_node}" not found.`);
  }

  nextState.current_node_id = nextNode.node_id;
  nextState = applyEnterNodeEffects(scenario, nextState, nextNode);

  if (nextNode.node_type === "audit_result") {
    nextState.completed = true;
  }

  return {
    nextState,
    nextNode,
    allCoreFieldsCorrect,
    missingRequiredEvidence,
  };
}

export function applyScoreDelta(
  current: ScoreState,
  delta?: Partial<ScoreState>,
): ScoreState {
  if (!delta) return { ...current };

  return {
    compliance: current.compliance + (delta.compliance ?? 0),
    communication: current.communication + (delta.communication ?? 0),
    detection: current.detection + (delta.detection ?? 0),
    risk: current.risk + (delta.risk ?? 0),
    conduct: current.conduct + (delta.conduct ?? 0),
  };
}

export function addEvidence(
  scenario: Scenario,
  state: RuntimeState,
  awarded: AwardedEvidenceRef,
): RuntimeState {
  const alreadyExists = state.evidence_found.some(
    (e) =>
      e.evidence_id === awarded.evidence_id &&
      e.source_node_id === awarded.source_node_id,
  );

  if (alreadyExists) return state;

  const catalogItem = scenario.evidence_catalog?.find(
    (item) => item.evidence_id === awarded.evidence_id,
  );

  const evidence: RuntimeEvidence = {
    evidence_id: awarded.evidence_id,
    source_node_id: awarded.source_node_id,
    type: catalogItem?.type,
    label: catalogItem?.label,
    severity: catalogItem?.severity,
    is_required_for_audit: catalogItem?.is_required_for_audit,
  };

  return {
    ...state,
    evidence_found: [...state.evidence_found, evidence],
  };
}

export function areDocumentationCoreFieldsCorrect(
  node: DocumentationNode,
  values: Record<string, string>,
): boolean {
  for (const field of node.fields) {
    if (field.input_type === "single_select" && field.correct_value) {
      if ((values[field.field_id] ?? "") !== field.correct_value) {
        return false;
      }
    }

    if (field.input_type === "text" && field.scoring_rules?.must_include_any?.length) {
      const submitted = (values[field.field_id] ?? "").toLowerCase();
      const matchesKeyword = field.scoring_rules.must_include_any.some((keyword) =>
        submitted.includes(keyword.toLowerCase()),
      );
      if (!matchesKeyword) {
        return false;
      }
    }
  }

  return true;
}

export function getCurrentNode(
  scenario: Scenario,
  state: RuntimeState,
): ScenarioNode | null {
  return getNodeById(scenario, state.current_node_id);
}

export function cloneRuntimeState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    score: { ...state.score },
    visited_nodes: [...state.visited_nodes],
    evidence_found: [...state.evidence_found],
    behavior_tags: [...state.behavior_tags],
    audit_flags: [...state.audit_flags],
    documentation_results: { ...state.documentation_results },
    selected_choice_ids: [...state.selected_choice_ids],
  };
}

function mergeUniqueStrings(existing: string[], incoming: string[]): string[] {
  return Array.from(new Set([...existing, ...incoming]));
}