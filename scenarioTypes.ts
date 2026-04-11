// scenarioTypes.ts
// Shared StormSim scenario and runtime types.

export type ScoreCategory =
  | "compliance"
  | "communication"
  | "detection"
  | "risk"
  | "conduct";

export type ScoreState = Record<ScoreCategory, number>;

export interface ScenarioImage {
  image_id: string;
  purpose: string;
}

export interface BehaviorTagDefinitions {
  [tag: string]: string;
}

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

export interface DocumentationFieldBase {
  field_id: string;
  label: string;
  input_type: "single_select" | "text";
}

export interface DocumentationSingleSelectField extends DocumentationFieldBase {
  input_type: "single_select";
  options: string[];
  correct_value?: string;
}

export interface DocumentationTextField extends DocumentationFieldBase {
  input_type: "text";
  correct_value?: string;
  scoring_rules?: {
    must_include_any?: string[];
  };
}

export type DocumentationField =
  | DocumentationSingleSelectField
  | DocumentationTextField;

export interface DocumentationScoring {
  all_core_fields_correct?: Partial<ScoreState>;
  otherwise?: Partial<ScoreState>;
}

export interface CompletionLogic {
  critical_fail_conditions?: string[];
  pass_with_remediation_conditions?: string[];
  exemplary_completion_conditions?: string[];
}

export interface AuditRule {
  rule_id: string;
  condition: string;
  message: string;
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
}

export interface StandardNode extends BaseNode {
  node_type: "dialogue" | "inspection" | "decision";
  choices: Choice[];
  evidence_awarded_on_enter?: AwardedEvidenceRef[];
}

export interface DocumentationNode extends BaseNode {
  node_type: "documentation";
  required_evidence?: string[];
  fields: DocumentationField[];
  scoring?: DocumentationScoring;
  behavior_tags_on_fail?: string[];
  next_node: string | null;
}

export interface AuditNode extends BaseNode {
  node_type: "audit_result";
  audit_rules?: AuditRule[];
  completion_logic?: CompletionLogic;
  next_node: null;
}

export type ScenarioNode = StandardNode | DocumentationNode | AuditNode;

export interface ScenarioStateModelReference {
  score_categories: ScoreCategory[];
  tracked_state_keys: string[];
}

export interface Scenario {
  scenario_id: string;
  title: string;
  difficulty: string;
  skills: string[];
  estimated_minutes: number;
  regional_ruleset: string;
  start_node_id: string;
  image_base_path?: string;
  images?: ScenarioImage[];
  behavior_tag_definitions?: BehaviorTagDefinitions;
  evidence_catalog?: EvidenceCatalogItem[];
  state_model_reference?: ScenarioStateModelReference;
  nodes: ScenarioNode[];
}

export interface DocumentationNodeResult {
  values: Record<string, string>;
  allCoreFieldsCorrect: boolean;
  missingRequiredEvidence: string[];
  fieldErrors?: Record<string, string>;
}

export interface DocumentationResults {
  [nodeId: string]: DocumentationNodeResult;
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
  fieldErrors: Record<string, string>;
}

export interface DocumentationEvaluationResult {
  allCoreFieldsCorrect: boolean;
  missingRequiredEvidence: string[];
  fieldErrors: Record<string, string>;
}