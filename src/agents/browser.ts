import type { ApplicationPlan, BrowserStep } from "../types.ts";
import { assertNoSubmitSteps } from "./applicationPrep.ts";

export interface AssistedBrowserSession {
  safeMode: true;
  applicationPlanId: string;
  steps: BrowserStep[];
  blockedActions: string[];
  reviewStop: BrowserStep;
}

export function createAssistedBrowserSession(plan: ApplicationPlan): AssistedBrowserSession {
  const safeSteps = plan.browserSteps.filter((step) => step.action !== "stop_for_review");
  const reviewStop = plan.browserSteps.find((step) => step.action === "stop_for_review") ?? {
    action: "stop_for_review",
    selector: `button[type="submit"], input[type="submit"]`,
    note: "Stop before final submission."
  } satisfies BrowserStep;

  assertNoSubmitSteps([...safeSteps, reviewStop]);
  return {
    safeMode: true,
    applicationPlanId: plan.id,
    steps: safeSteps,
    blockedActions: ["click submit", "sign attestation", "send email", "request recommendation", "pay fee", "upload without approval"],
    reviewStop
  };
}
