// documentationEvaluator.ts
// Validation and scoring logic for StormSim documentation nodes.

import type {
  DocumentationEvaluationResult,
  DocumentationField,
  DocumentationNode,
} from "./scenarioTypes";

export function evaluateDocumentationSubmission(
  node: DocumentationNode,
  values: Record<string, string>,
  foundEvidenceIds: string[],
): DocumentationEvaluationResult {
  const fieldErrors: Record<string, string> = {};

  const missingRequiredEvidence =
    node.required_evidence?.filter(
      (requiredId) => !foundEvidenceIds.includes(requiredId),
    ) ?? [];

  for (const field of node.fields) {
    const rawValue = values[field.field_id] ?? "";
    const value = rawValue.trim();

    if (!value) {
      fieldErrors[field.field_id] = "This field is required.";
      continue;
    }

    const maybeError = validateField(field, value);
    if (maybeError) {
      fieldErrors[field.field_id] = maybeError;
    }
  }

  const allCoreFieldsCorrect =
    Object.keys(fieldErrors).length === 0 &&
    missingRequiredEvidence.length === 0 &&
    areAllCoreFieldsCorrect(node, values);

  return {
    allCoreFieldsCorrect,
    missingRequiredEvidence,
    fieldErrors,
  };
}

export function areAllCoreFieldsCorrect(
  node: DocumentationNode,
  values: Record<string, string>,
): boolean {
  for (const field of node.fields) {
    const submitted = (values[field.field_id] ?? "").trim();

    if (!submitted) {
      return false;
    }

    if (field.input_type === "single_select" && field.correct_value) {
      if (submitted !== field.correct_value) {
        return false;
      }
    }

    if (field.input_type === "text" && field.scoring_rules?.must_include_any?.length) {
      const normalized = normalizeText(submitted);
      const matched = field.scoring_rules.must_include_any.some((keyword) =>
        normalized.includes(normalizeText(keyword)),
      );

      if (!matched) {
        return false;
      }
    }
  }

  return true;
}

export function getDocumentationFieldInitialValues(
  node: DocumentationNode,
): Record<string, string> {
  return node.fields.reduce<Record<string, string>>((acc, field) => {
    acc[field.field_id] = "";
    return acc;
  }, {});
}

export function validateField(
  field: DocumentationField,
  value: string,
): string | null {
  if (!value.trim()) {
    return "This field is required.";
  }

  if (field.input_type === "single_select") {
    if (!field.options.includes(value)) {
      return "Invalid selection.";
    }
    return null;
  }

  if (field.input_type === "text") {
    if (value.trim().length < 8) {
      return "Please add a more complete note.";
    }
    return null;
  }

  return null;
}

export function getDocumentationScoreLabel(
  allCoreFieldsCorrect: boolean,
  missingRequiredEvidence: string[],
): "success" | "warning" {
  if (allCoreFieldsCorrect && missingRequiredEvidence.length === 0) {
    return "success";
  }

  return "warning";
}

export function buildDocumentationFeedback(
  node: DocumentationNode,
  values: Record<string, string>,
  foundEvidenceIds: string[],
): string[] {
  const result = evaluateDocumentationSubmission(node, values, foundEvidenceIds);
  const feedback: string[] = [];

  if (result.missingRequiredEvidence.length > 0) {
    feedback.push(
      `Missing required evidence: ${result.missingRequiredEvidence.join(", ")}.`,
    );
  }

  for (const field of node.fields) {
    const submitted = (values[field.field_id] ?? "").trim();
    if (!submitted) continue;

    if (field.input_type === "single_select" && field.correct_value) {
      if (submitted !== field.correct_value) {
        feedback.push(
          `"${field.label}" was inaccurate. Expected a value aligned with the inspection evidence.`,
        );
      }
    }

    if (field.input_type === "text" && field.scoring_rules?.must_include_any?.length) {
      const normalized = normalizeText(submitted);
      const matched = field.scoring_rules.must_include_any.some((keyword) =>
        normalized.includes(normalizeText(keyword)),
      );

      if (!matched) {
        feedback.push(
          `"${field.label}" should mention at least one key observation: ${field.scoring_rules.must_include_any.join(", ")}.`,
        );
      }
    }
  }

  if (
    feedback.length === 0 &&
    result.allCoreFieldsCorrect &&
    result.missingRequiredEvidence.length === 0
  ) {
    feedback.push("Documentation is complete and aligned with the evidence found.");
  }

  return feedback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}