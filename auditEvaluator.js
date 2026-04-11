export function evaluateAudit(scenario, state) {
  const issues = [];
  const missedEvidenceIds = [];
  const documentationProblems = [];
  const behaviorConcerns = [];

  const hasEvidence = (evidenceId) =>
    state.evidence_found.some((item) => item.evidence_id === evidenceId);

  const hasBehaviorTag = (tag) => state.behavior_tags.includes(tag);
  const selectedChoice = (choiceId) => state.selected_choice_ids.includes(choiceId);

  const drainDocumentation = state.documentation_results["N_doc_1"];
  const drainDocCorrect = Boolean(drainDocumentation?.allCoreFieldsCorrect);

  if (selectedChoice("N1_C3")) {
    issues.push({
      rule_id: "FAIL_1",
      message: "You allowed pressure from the owner to prevent the inspection.",
      severity: "critical",
    });
  }

  const missingHiddenDrain = !hasEvidence("evidence_hidden_drain");
  const missingOilResidue = !hasEvidence("evidence_oil_residue");
  if (missingHiddenDrain || missingOilResidue) {
    if (missingHiddenDrain) missedEvidenceIds.push("evidence_hidden_drain");
    if (missingOilResidue) missedEvidenceIds.push("evidence_oil_residue");

    issues.push({
      rule_id: "A1",
      message:
        "You missed a drain-related pollution indicator and failed to verify an owner statement.",
      severity: "critical",
    });
  }

  const sawDrainEvidence =
    hasEvidence("evidence_hidden_drain") || hasEvidence("evidence_oil_residue");

  if (sawDrainEvidence && !drainDocCorrect) {
    documentationProblems.push(
      "Drain finding was documented incorrectly or incompletely.",
    );

    issues.push({
      rule_id: "A2",
      message:
        "You saw the evidence but documented it incorrectly, which weakens enforcement and follow-up.",
      severity: "warning",
    });
  }

  if (!hasEvidence("evidence_unlabeled_containers")) {
    missedEvidenceIds.push("evidence_unlabeled_containers");

    issues.push({
      rule_id: "A3",
      message:
        "You did not inspect a suspicious storage area and missed a likely storage compliance issue.",
      severity: "warning",
    });
  }

  if (hasBehaviorTag("premature_escalation")) {
    behaviorConcerns.push("Premature escalation increased resistance.");

    issues.push({
      rule_id: "A4",
      message:
        "Your tone created avoidable resistance and increased complaint risk.",
      severity: "warning",
    });
  }

  if (hasBehaviorTag("accepted_unverified_statement")) {
    behaviorConcerns.push("Accepted an owner statement without verifying it.");
  }

  if (hasBehaviorTag("passive_avoidance")) {
    behaviorConcerns.push("Avoided a reasonable inspection follow-up step.");
  }

  if (hasBehaviorTag("poor_documentation")) {
    behaviorConcerns.push("Documentation quality was below inspection standard.");
  }

  if (hasBehaviorTag("missed_violation")) {
    behaviorConcerns.push("A visible violation was not acted on.");
  }

  if (hasBehaviorTag("missed_followup")) {
    behaviorConcerns.push("A suspicious area was not followed up properly.");
  }

  const outcome = determineCompletionOutcome(state, {
    hasAllRequiredEvidence:
      hasEvidence("evidence_hidden_drain") &&
      hasEvidence("evidence_oil_residue") &&
      hasEvidence("evidence_unlabeled_containers"),
    drainDocCorrect,
    hasCriticalBehaviorTags: hasBehaviorTag("premature_escalation"),
    hasCriticalIssues: issues.some((issue) => issue.severity === "critical"),
  });

  return {
    outcome,
    issues,
    missedEvidenceIds: unique(missedEvidenceIds),
    documentationProblems: unique(documentationProblems),
    behaviorConcerns: unique(behaviorConcerns),
    summary: buildSummary(outcome),
    finalScore: { ...state.score },
  };
}

function determineCompletionOutcome(state, flags) {
  if (state.selected_choice_ids.includes("N1_C3")) {
    return "critical_fail";
  }

  if (flags.hasCriticalIssues) {
    return "critical_fail";
  }

  if (
    flags.hasAllRequiredEvidence &&
    flags.drainDocCorrect &&
    !flags.hasCriticalBehaviorTags
  ) {
    return "exemplary_completion";
  }

  const totalScore = getTotalScore(state.score);
  const hasAnyBehaviorTags = state.behavior_tags.length > 0;

  if (totalScore >= 20 && (hasAnyBehaviorTags || !flags.drainDocCorrect)) {
    return "pass_with_remediation";
  }

  return "soft_fail";
}

function buildSummary(outcome) {
  switch (outcome) {
    case "exemplary_completion":
      return "You completed the inspection well, verified key clues, documented the drain finding correctly, and avoided major behavioral errors.";
    case "pass_with_remediation":
      return "You completed the scenario, but important habits or documentation gaps need correction before field use.";
    case "soft_fail":
      return "You finished the inspection, but you missed or mishandled enough important items that the result falls below standard.";
    case "critical_fail":
      return "The scenario resulted in a critical failure due to abandonment, missed major evidence, or a severe breakdown in inspection judgment.";
    default:
      return "Audit complete.";
  }
}

function getTotalScore(score) {
  return (
    score.compliance +
    score.communication +
    score.detection +
    score.risk +
    score.conduct
  );
}

function unique(items) {
  return Array.from(new Set(items));
}
