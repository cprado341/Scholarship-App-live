import { AppRepository } from "./db.ts";
import { runWeeklyPipeline } from "./agents/pipeline.ts";
import type { Approval, ApplicationPlan, DashboardData, EssayDraft, Scholarship } from "./types.ts";

const command = process.argv[2] ?? "help";
const repo = new AppRepository({ baseDir: process.cwd() });

try {
  if (command === "weekly") {
    const run = await runWeeklyPipeline(repo);
    const dashboard = repo.dashboard();
    printJson({
      command,
      status: run.status,
      summary: run.summary,
      counts: counts(dashboard)
    });
  } else if (command === "review") {
    const dashboard = repo.dashboard();
    printJson({
      command,
      status: "completed",
      summary: "Daily scholarship review check completed.",
      urgentDeadlines: upcomingDeadlines(dashboard.scholarships),
      pendingApprovals: pendingApprovals(dashboard.approvals),
      incompletePlans: incompletePlans(dashboard.applicationPlans, dashboard.scholarships),
      essayDraftsNeedingReview: essayDraftsNeedingReview(dashboard.essayDrafts, dashboard.scholarships),
      counts: counts(dashboard)
    });
  } else {
    printJson({
      command,
      status: "usage",
      usage: "node --disable-warning=ExperimentalWarning src/automation.ts weekly|review"
    });
  }
} finally {
  repo.close();
}

function counts(dashboard: DashboardData) {
  return {
    students: dashboard.students.length,
    scholarships: dashboard.scholarships.length,
    applicationPlans: dashboard.applicationPlans.length,
    essayDrafts: dashboard.essayDrafts.length,
    pendingApprovals: dashboard.approvals.filter((approval) => approval.status === "pending").length
  };
}

function upcomingDeadlines(scholarships: Scholarship[]) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
  return scholarships
    .map((scholarship) => ({ scholarship, deadline: new Date(scholarship.deadline) }))
    .filter(({ deadline }) => !Number.isNaN(deadline.getTime()) && deadline >= now && deadline <= horizon)
    .sort((a, b) => a.deadline.getTime() - b.deadline.getTime())
    .map(({ scholarship, deadline }) => ({
      title: scholarship.title,
      deadline: deadline.toISOString().slice(0, 10),
      status: scholarship.status,
      fitScore: scholarship.fitScore
    }));
}

function pendingApprovals(approvals: Approval[]) {
  return approvals
    .filter((approval) => approval.status === "pending")
    .map((approval) => ({
      actionType: approval.actionType,
      riskLevel: approval.riskLevel,
      summary: approval.summary,
      requestedAt: approval.requestedAt
    }));
}

function incompletePlans(plans: ApplicationPlan[], scholarships: Scholarship[]) {
  return plans
    .filter((plan) => plan.missingFields.length > 0 || plan.documentRequests.length > 0)
    .map((plan) => ({
      scholarship: scholarships.find((scholarship) => scholarship.id === plan.scholarshipId)?.title ?? "Unknown scholarship",
      missingFields: plan.missingFields,
      documentRequests: plan.documentRequests,
      status: plan.status
    }));
}

function essayDraftsNeedingReview(drafts: EssayDraft[], scholarships: Scholarship[]) {
  return drafts
    .filter((draft) => draft.status !== "approved")
    .map((draft) => ({
      scholarship: scholarships.find((scholarship) => scholarship.id === draft.scholarshipId)?.title ?? "Unknown scholarship",
      status: draft.status,
      unsupportedClaims: draft.unsupportedClaims
    }));
}

function printJson(payload: unknown) {
  console.log(JSON.stringify(payload, null, 2));
}
