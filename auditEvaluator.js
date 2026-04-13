export function evaluateAudit(scenario, state) {
  const issues = [];
  const missedEvidenceIds = [];
  const documentationProblems = [];
  const behaviorConcerns = [];

  const hasEvidence = (evidenceId) =>
    state.evidence_found.some((item) => item.evidence_id === evidenceId);

  const hasBehaviorTag = (tag) => state.behavior_tags.includes(tag);
  const documentation = state.documentation_results["N_doc_1"];
  const documentationLevel = documentation?.completionLevel ?? "otherwise";

  const missingHiddenDrain = !hasEvidence("evidence_hidden_drain");
  const missingOilResidue = !hasEvidence("evidence_oil_residue");
  const missingStorageIssue = !hasEvidence("evidence_unlabeled_containers");

  if (missingHiddenDrain || missingOilResidue) {
    if (missingHiddenDrain) missedEvidenceIds.push("evidence_hidden_drain");
    if (missingOilResidue) missedEvidenceIds.push("evidence_oil_residue");

    issues.push({
      rule_id: "A1",
      message:
        "You did not fully verify and document the drain-related pollution indicator.",
      severity: "warning",
    });
  }

  const sawDrainEvidence =
    hasEvidence("evidence_hidden_drain") || hasEvidence("evidence_oil_residue");

  if (sawDrainEvidence && documentationLevel !== "preferred_or_acceptable") {
    documentationProblems.push(
      documentationLevel === "partial_credit"
        ? "Drain documentation was partly complete, but not strong enough for ideal follow-up."
        : "Drain documentation was too vague or incomplete for solid follow-up.",
    );

    issues.push({
      rule_id: "A2",
      message:
        "You saw the condition, but your documentation would weaken follow-up and enforcement.",
      severity: documentationLevel === "partial_credit" ? "info" : "warning",
    });
  }

  if (missingStorageIssue) {
    missedEvidenceIds.push("evidence_unlabeled_containers");

    issues.push({
      rule_id: "A3",
      message:
        "You did not inspect or revisit a storage area that warranted follow-up.",
      severity: "warning",
    });
  }

  if (hasBehaviorTag("premature_escalation")) {
    behaviorConcerns.push("Tone escalated earlier than necessary.");
    issues.push({
      rule_id: "A4",
      message:
        "Your tone created avoidable resistance and increased complaint risk.",
      severity: "warning",
    });
  }

  if (hasBehaviorTag("accepted_unverified_statement")) {
    behaviorConcerns.push("An owner explanation was accepted without enough verification.");
  }

  if (hasBehaviorTag("passive_avoidance")) {
    behaviorConcerns.push("A reasonable follow-up step was delayed or avoided.");
  }

  if (hasBehaviorTag("poor_documentation")) {
    behaviorConcerns.push("Documentation quality would make later follow-up harder.");
  }

  if (hasBehaviorTag("missed_violation")) {
    behaviorConcerns.push("A visible issue was not fully documented or acted on.");
  }

  if (hasBehaviorTag("missed_followup")) {
    behaviorConcerns.push("A clue was noticed but not followed through far enough.");
  }

  const outcome = determineCompletionOutcome(state, {
    hasAllRequiredEvidence:
      hasEvidence("evidence_hidden_drain") &&
      hasEvidence("evidence_oil_residue") &&
      hasEvidence("evidence_unlabeled_containers"),
    missingAllRequiredEvidence:
      !hasEvidence("evidence_hidden_drain") &&
      !hasEvidence("evidence_oil_residue") &&
      !hasEvidence("evidence_unlabeled_containers"),
    documentationLevel,
    hasCriticalBehaviorTags: hasBehaviorTag("premature_escalation"),
    hasConcerningSignals:
      issues.length > 0 || behaviorConcerns.length > 0 || documentationLevel !== "preferred_or_acceptable",
  });

  return {
    outcome,
    issues,
    missedEvidenceIds: unique(missedEvidenceIds),
    documentationProblems: unique(documentationProblems),
    behaviorConcerns: unique(behaviorConcerns),
    summary: buildSummary(outcome),
    finalScore: { ...state.score },
    documentationLevel,
  };
}

function determineCompletionOutcome(state, flags) {
  if (flags.missingAllRequiredEvidence) {
    return "critical_fail";
  }

  if (
    flags.hasAllRequiredEvidence &&
    flags.documentationLevel === "preferred_or_acceptable" &&
    !flags.hasCriticalBehaviorTags
  ) {
    return "exemplary_completion";
  }

  const totalScore = getTotalScore(state.score);

  if (totalScore > 0 && flags.hasConcerningSignals) {
    return "pass_with_remediation";
  }

  return "soft_fail";
}

function buildSummary(outcome) {
  switch (outcome) {
    case "exemplary_completion":
      return "You completed the inspection well, followed up on key clues, documented the drain condition at a usable level, and closed the visit professionally.";
    case "pass_with_remediation":
      return "You completed the scenario, but some follow-up, documentation, or tone choices would still need coaching before field use.";
    case "soft_fail":
      return "You finished the inspection, but enough evidence, follow-up, or documentation gaps remained that the overall result falls below standard.";
    case "critical_fail":
      return "The scenario ended in a critical failure because the inspection missed all of the key audit evidence.";
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
