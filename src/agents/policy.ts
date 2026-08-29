import type { Approval } from "../types.ts";

const sensitiveActions = new Set<Approval["actionType"]>([
  "account_creation",
  "file_upload",
  "email_send",
  "portal_submit",
  "signature",
  "payment",
  "recommendation_request",
  "attestation"
]);

export function isSensitiveAction(actionType: Approval["actionType"]): boolean {
  return sensitiveActions.has(actionType);
}

export function canExecuteExternalAction(actionType: Approval["actionType"], approval?: Approval): boolean {
  if (!isSensitiveAction(actionType)) return true;
  return approval?.status === "approved";
}

export function riskForRequirements(requirements: { kind: string; required: boolean }[]): Approval["riskLevel"] {
  if (requirements.some((requirement) => requirement.kind === "signature" || requirement.kind === "payment")) {
    return "high";
  }
  if (requirements.some((requirement) => requirement.kind === "attestation" || requirement.kind === "recommendation")) {
    return "medium";
  }
  return "low";
}

export function approvalActionsForRequirements(requirements: { kind: string; label: string }[]): Approval["actionType"][] {
  const actions = new Set<Approval["actionType"]>();
  for (const requirement of requirements) {
    if (requirement.kind === "recommendation") actions.add("recommendation_request");
    if (requirement.kind === "signature") actions.add("signature");
    if (requirement.kind === "payment") actions.add("payment");
  }
  return [...actions];
}
