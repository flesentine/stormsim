export function evaluateDocumentationSubmission(
  node,
  values,
  foundEvidenceIds,
) {
  const fieldErrors = {};
  const fieldAssessments = {};

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
      continue;
    }

    fieldAssessments[field.field_id] = assessDocumentationField(field, value);
  }

  const completionLevel = determineCompletionLevel(
    node,
    fieldAssessments,
    missingRequiredEvidence,
    fieldErrors,
  );

  return {
    allCoreFieldsCorrect: completionLevel === "preferred_or_acceptable",
    missingRequiredEvidence,
    fieldErrors,
    fieldAssessments,
    completionLevel,
    partialCreditAwarded: completionLevel === "partial_credit",
  };
}

export function determineCompletionLevel(
  node,
  fieldAssessments,
  missingRequiredEvidence = [],
  fieldErrors = {},
) {
  if (Object.keys(fieldErrors).length > 0) {
    return "otherwise";
  }

  if (missingRequiredEvidence.length > 0) {
    return hasAnyPositiveAssessment(node, fieldAssessments)
      ? "partial_credit"
      : "otherwise";
  }

  const requiredAssessments = node.fields.map(
    (field) => fieldAssessments[field.field_id] ?? { status: "incorrect" },
  );

  const allAcceptable = requiredAssessments.every((assessment) =>
    assessment.status === "preferred" || assessment.status === "acceptable",
  );

  if (allAcceptable) {
    return "preferred_or_acceptable";
  }

  const hasPartial = requiredAssessments.some(
    (assessment) =>
      assessment.status === "partial" ||
      assessment.status === "acceptable" ||
      assessment.status === "preferred",
  );

  return hasPartial ? "partial_credit" : "otherwise";
}

export function getDocumentationFieldInitialValues(node) {
  return node.fields.reduce((acc, field) => {
    acc[field.field_id] = "";
    return acc;
  }, {});
}

export function validateField(field, value) {
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
    if (value.trim().length < 12) {
      return "Please add a more complete note.";
    }
    return null;
  }

  return null;
}

export function assessDocumentationField(field, value) {
  if (field.input_type === "single_select") {
    return assessSingleSelectField(field, value);
  }

  if (field.input_type === "text") {
    return assessTextField(field, value);
  }

  return { status: "incorrect" };
}

export function getDocumentationScoreLabel(completionLevel) {
  switch (completionLevel) {
    case "preferred_or_acceptable":
      return "success";
    case "partial_credit":
      return "warning";
    default:
      return "warning";
  }
}

export function buildDocumentationFeedback(node, values, foundEvidenceIds) {
  const result = evaluateDocumentationSubmission(node, values, foundEvidenceIds);
  const feedback = [];

  if (result.missingRequiredEvidence.length > 0) {
    const evidenceLabels =
      node.required_evidence_labels?.length === result.missingRequiredEvidence.length
        ? node.required_evidence_labels
        : result.missingRequiredEvidence;

    feedback.push(
      `Key evidence was not confirmed before documenting: ${evidenceLabels.join(", ")}.`,
    );
  }

  for (const field of node.fields) {
    const assessment = result.fieldAssessments[field.field_id];
    if (!assessment) continue;

    if (assessment.status === "incorrect") {
      feedback.push(`"${field.label}" needs to be more aligned with what was observed.`);
    }

    if (assessment.status === "partial" && field.input_type === "text") {
      feedback.push(`"${field.label}" captures part of the issue, but could be more complete.`);
    }
  }

  if (result.completionLevel === "preferred_or_acceptable") {
    feedback.push("Documentation is complete enough to support follow-up.");
  } else if (result.completionLevel === "partial_credit") {
    feedback.push("Documentation captures some of the issue, but the record could be stronger.");
  } else if (feedback.length === 0) {
    feedback.push("Documentation needs more substance to support follow-up.");
  }

  return feedback;
}

function assessSingleSelectField(field, value) {
  const normalized = normalizeText(value);
  const preferred = normalizeText(field.preferred_value ?? field.correct_value ?? "");
  const acceptableValues = (field.acceptable_values ?? []).map(normalizeText);

  if (preferred && normalized === preferred) {
    return { status: "preferred" };
  }

  if (acceptableValues.includes(normalized)) {
    return { status: "acceptable" };
  }

  return { status: "incorrect" };
}

function assessTextField(field, value) {
  const normalized = normalizeText(value);
  const semanticGroups = field.scoring_rules?.semantic_groups ?? [];
  const minimumGroupsToMatch =
    field.scoring_rules?.minimum_groups_to_match ?? semanticGroups.length;

  if (semanticGroups.length === 0) {
    return { status: "acceptable", matchedGroups: 0, totalGroups: 0 };
  }

  const matchedGroups = semanticGroups.filter((group) =>
    group.some((keyword) => normalized.includes(normalizeText(keyword))),
  ).length;

  if (matchedGroups >= minimumGroupsToMatch) {
    return {
      status: matchedGroups === semanticGroups.length ? "preferred" : "acceptable",
      matchedGroups,
      totalGroups: semanticGroups.length,
    };
  }

  if (field.scoring_rules?.partial_credit_allowed && matchedGroups > 0) {
    return {
      status: "partial",
      matchedGroups,
      totalGroups: semanticGroups.length,
    };
  }

  return {
    status: "incorrect",
    matchedGroups,
    totalGroups: semanticGroups.length,
  };
}

function hasAnyPositiveAssessment(node, fieldAssessments) {
  return node.fields.some((field) => {
    const assessment = fieldAssessments[field.field_id];
    return assessment && assessment.status !== "incorrect";
  });
}

function normalizeText(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}
