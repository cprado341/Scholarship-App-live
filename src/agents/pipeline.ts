import type { AgentRun } from "../types.ts";
import { AppRepository } from "../db.ts";
import { discoverScholarshipsFromPublicSources } from "./discovery.ts";
import { dedupeScholarships, filterNoEssayScholarships, scoreScholarship, scholarshipRequiresEssay } from "./eligibility.ts";
import { prepareApplicationPlan } from "./applicationPrep.ts";
import { approvalActionsForRequirements, riskForRequirements } from "./policy.ts";

export interface PipelineProgress {
  (event: { type: string; message: string; data?: unknown }): void;
}

export const TOP_REVIEW_MATCH_LIMIT = 5;

export async function runWeeklyPipeline(
  repo: AppRepository,
  familyId = repo.getDefaultFamilyId(),
  progress?: PipelineProgress
): Promise<AgentRun> {
  repo.seedIfEmpty(familyId);
  const run = repo.startAgentRun("weekly_pipeline", "Finding no-essay scholarships and preparing the review queue.", familyId);
  progress?.({ type: "agent_progress", message: "Starting no-essay scholarship run.", data: { runId: run.id } });

  try {
    const students = repo.listStudents(familyId);
    const student = students[0];
    progress?.({ type: "agent_progress", message: `Using ${student.profile.preferredName}'s profile for matching.` });
    const allDiscovered = dedupeScholarships(discoverScholarshipsFromPublicSources());
    const discovered = filterNoEssayScholarships(allDiscovered);
    const skippedEssayRequired = allDiscovered.length - discovered.length;
    progress?.({ type: "agent_progress", message: `Discovered ${discovered.length} no-essay scholarship candidates.` });
    const documents = repo.listDocuments(familyId);
    const preparedScholarshipIds: string[] = [];

    for (const item of discovered) {
      const initial = repo.upsertScholarship(item, 0, "medium", familyId);
      const score = scoreScholarship(student, initial);
      repo.updateScholarshipScore(initial.id, score.fitScore, score.effort, score.fitScore >= 60 ? "matched" : "new", familyId);
      repo.audit("agent", "scholarship_scored", "scholarship", initial.id, {
        fitScore: score.fitScore,
        effort: score.effort,
        rationale: score.rationale,
        risks: score.risks
      }, familyId);
      progress?.({
        type: "agent_progress",
        message: `Scored ${initial.title}: ${score.fitScore}.`,
        data: { scholarshipId: initial.id, fitScore: score.fitScore }
      });
    }

    const ranked = repo
      .listScholarships(familyId)
      .filter((scholarship) => scholarship.fitScore >= 60 && !scholarshipRequiresEssay(scholarship))
      .slice(0, TOP_REVIEW_MATCH_LIMIT);
    const activeReviewPlanIds: string[] = [];
    for (const scholarship of ranked) {
      repo.updateScholarshipScore(scholarship.id, scholarship.fitScore, scholarship.effort, "ready_for_review", familyId);
      const refreshed = repo.getScholarship(scholarship.id, familyId)!;
      const plan = repo.upsertApplicationPlan(prepareApplicationPlan(student, refreshed, documents), familyId);
      activeReviewPlanIds.push(plan.id);
      progress?.({ type: "agent_progress", message: `Prepared review plan for ${refreshed.title}.`, data: { planId: plan.id } });
      const riskLevel = riskForRequirements(refreshed.requirements);

      repo.createApprovalIfMissing({
        actionType: "portal_submit",
        targetType: "application_plan",
        targetId: plan.id,
        summary: `Review ${refreshed.title} for ${student.profile.preferredName}. The app will not submit without this approval.`,
        riskLevel
      }, familyId);

      if (plan.browserSteps.some((step) => step.action === "upload")) {
        repo.createApprovalIfMissing({
          actionType: "file_upload",
          targetType: "application_plan",
          targetId: plan.id,
          summary: `Approve document staging/upload for ${refreshed.title}.`,
          riskLevel: "medium"
        }, familyId);
      }

      for (const actionType of approvalActionsForRequirements(refreshed.requirements)) {
        repo.createApprovalIfMissing({
          actionType,
          targetType: "application_plan",
          targetId: plan.id,
          summary: `Review ${actionType.replaceAll("_", " ")} language for ${refreshed.title}. Chrome prep will stop until approved.`,
          riskLevel: actionType === "signature" || actionType === "payment" ? "high" : "medium"
        }, familyId);
      }

      repo.audit("agent", "application_ready_for_review", "application_plan", plan.id, {
        scholarshipId: refreshed.id,
        missingFields: plan.missingFields
      }, familyId);
      preparedScholarshipIds.push(refreshed.id);
    }
    const supersededReviewItems = repo.supersedeStaleApplicationReviewApprovals(activeReviewPlanIds, familyId);

    progress?.({ type: "agent_progress", message: `Queued ${preparedScholarshipIds.length} applications for human review.` });
    return repo.completeAgentRun(
      run.id,
      `Prepared ${preparedScholarshipIds.length} no-essay scholarship applications for review.`,
      {
        discovered: discovered.length,
        skippedEssayRequired,
        preparedForReview: preparedScholarshipIds.length,
        supersededReviewItems,
        topReviewMatchLimit: TOP_REVIEW_MATCH_LIMIT,
        scholarshipIds: preparedScholarshipIds
      },
      "completed",
      familyId
    );
  } catch (error) {
    return repo.completeAgentRun(
      run.id,
      error instanceof Error ? error.message : "Weekly pipeline failed.",
      { error: String(error) },
      "failed",
      familyId
    );
  }
}
