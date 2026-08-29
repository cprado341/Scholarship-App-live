import type { ApplicationPlan, Approval, BrowserStep, Scholarship, SubmissionSession } from "../types.ts";
import { createAssistedBrowserSession } from "./browser.ts";
import { canExecuteExternalAction } from "./policy.ts";

export const SCHOLARSHIP_CHROME_PROFILE_LABEL = "Scholarship Applications";

const requirementApprovalMap: Record<string, Approval["actionType"]> = {
  recommendation: "recommendation_request",
  signature: "signature",
  payment: "payment"
};

export function createChromeSubmissionSessionDraft(
  plan: ApplicationPlan,
  approvals: Approval[],
  scholarship?: Scholarship
): Omit<
  SubmissionSession,
  | "id"
  | "familyId"
  | "createdAt"
  | "updatedAt"
  | "confirmationText"
  | "screenshotName"
  | "screenshotPath"
  | "submittedAt"
> {
  const assisted = createAssistedBrowserSession(plan);
  const blockers = detectSubmissionBlockers(plan, approvals, scholarship);
  const uploadApproved = isApproved(approvals, "file_upload", plan.id);
  const steps = assisted.steps.filter((step) => step.action !== "upload" || uploadApproved);
  const launchUrl = plan.browserSteps.find((step): step is Extract<BrowserStep, { action: "navigate" }> => step.action === "navigate")?.url ?? "";

  return {
    applicationPlanId: plan.id,
    scholarshipId: plan.scholarshipId,
    studentId: plan.studentId,
    status: blockers.length ? "blocked" : "created",
    chromeProfile: "scholarship",
    chromeProfileLabel: SCHOLARSHIP_CHROME_PROFILE_LABEL,
    launchUrl,
    safeMode: true,
    steps,
    blockedActions: assisted.blockedActions,
    blockers,
    reviewStop: assisted.reviewStop
  };
}

export function detectSubmissionBlockers(plan: ApplicationPlan, approvals: Approval[], scholarship?: Scholarship): string[] {
  const blockers: string[] = [];
  const portalApproval = approvals.find(
    (approval) =>
      approval.actionType === "portal_submit" &&
      approval.targetType === "application_plan" &&
      approval.targetId === plan.id
  );

  if (!canExecuteExternalAction("portal_submit", portalApproval)) {
    blockers.push("Approve the application review before starting Chrome-guided submission prep.");
  }

  if (plan.browserSteps.some((step) => step.action === "upload") && !isApproved(approvals, "file_upload", plan.id)) {
    blockers.push("Approve file upload/staging before any document is staged in Chrome.");
  }

  for (const requirement of scholarship?.requirements ?? []) {
    const actionType = requirementApprovalMap[requirement.kind];
    if (!actionType) continue;
    if (!isApproved(approvals, actionType, plan.id)) {
      blockers.push(`${requirement.label} requires ${actionType.replaceAll("_", " ")} approval before Chrome prep can continue.`);
    }
  }

  return [...new Set(blockers)];
}

export function isApproved(approvals: Approval[], actionType: Approval["actionType"], planId: string): boolean {
  return approvals.some(
    (approval) =>
      approval.actionType === actionType &&
      approval.targetType === "application_plan" &&
      approval.targetId === planId &&
      approval.status === "approved"
  );
}
