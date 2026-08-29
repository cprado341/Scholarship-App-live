import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AppRepository } from "./db.ts";
import { runWeeklyPipeline } from "./agents/pipeline.ts";
import { createAssistedBrowserSession } from "./agents/browser.ts";
import { prepareApplicationPlan } from "./agents/applicationPrep.ts";
import { createChromeSubmissionSessionDraft } from "./agents/submission.ts";
import { clearSessionCookie, getSessionToken, setSessionCookie } from "./auth.ts";
import { startChromeAutofill, type ChromeAutofillResult } from "./chromeCompanion.ts";
import { sendPortalInviteEmail } from "./email.ts";
import { RealtimeHub } from "./realtime.ts";
import type { Approval, DocumentRecord, InviteEmailResult, PortalUser, Scholarship, SettingsData, Student, StudentProfile } from "./types.ts";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? "127.0.0.1";
const CRON_SECRET = process.env.CRON_SECRET ?? "local-cron-secret";
const baseDir = process.cwd();
const publicDir = path.join(baseDir, "public");
const repo = new AppRepository({ baseDir });
repo.seedIfEmpty();
const realtime = new RealtimeHub();

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) return sendJson(res, 400, { error: "Bad request" });
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const user = repo.getUserBySessionToken(getSessionToken(req));

    const privatePortalPaths = new Set(["/", "/index.html", "/portal.html"]);
    if (privatePortalPaths.has(url.pathname) && !user) {
      return redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`);
    }

    if ((url.pathname === "/login" || url.pathname === "/login.html") && user) {
      const next = safeNextPath(url.searchParams.get("next"));
      return redirect(res, next ?? "/portal.html");
    }

    if (url.pathname === "/login") {
      return serveStatic("/login.html", res);
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJson(req);
      const session = repo.authenticateUser(String(body.email ?? ""), String(body.password ?? ""));
      if (!session) return sendJson(res, 401, { error: "Email or password was not recognized." });
      setSessionCookie(res, session.token, session.expiresAt);
      return sendJson(res, 200, {
        user: {
          id: session.user.id,
          email: session.user.email,
          displayName: session.user.displayName,
          role: session.user.role
        }
      });
    }

    if (url.pathname === "/api/auth/accept-invite" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const session = repo.acceptPortalInvite(String(body.token ?? ""), String(body.password ?? ""));
        setSessionCookie(res, session.token, session.expiresAt);
        return sendJson(res, 200, {
          user: {
            id: session.user.id,
            email: session.user.email,
            displayName: session.user.displayName,
            role: session.user.role
          }
        });
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "Invite could not be accepted." });
      }
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      repo.deleteSessionByToken(getSessionToken(req));
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      if (!user) return sendJson(res, 401, { error: "Not signed in.", loginUrl: "/login" });
      return sendJson(res, 200, {
        user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
        family: repo.getFamily(user.familyId)
      });
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      return realtime.connect(currentUser.familyId, res);
    }

    if (url.pathname === "/api/companion/submission-session" && req.method === "GET") {
      const companion = repo.consumeCompanionToken(getBearerToken(req));
      if (!companion) return sendJson(res, 401, { error: "Companion token is invalid, expired, or already used." });
      const session = repo.getSubmissionSession(companion.submissionSessionId, companion.familyId);
      if (!session) return sendJson(res, 404, { error: "Submission session not found." });
      const applicationPlan = repo.getApplicationPlan(session.applicationPlanId, companion.familyId);
      if (!applicationPlan) return sendJson(res, 404, { error: "Application plan not found." });
      const student = repo.getStudent(session.studentId, companion.familyId);
      const scholarship = repo.getScholarship(session.scholarshipId, companion.familyId);
      return sendJson(res, 200, {
        submissionSession: session,
        applicationPlan,
        student: safeCompanionStudent(student),
        scholarship: safeCompanionScholarship(scholarship),
        documents: safeCompanionDocuments(repo.listDocuments(companion.familyId).filter((document) => document.studentId === session.studentId))
      });
    }

    if (url.pathname === "/api/cron/weekly" && (req.method === "POST" || req.method === "GET")) {
      if (!isAuthorizedCron(req)) return sendJson(res, 401, { error: "Missing or invalid cron secret." });
      const familyId = url.searchParams.get("familyId") ?? repo.getDefaultFamilyId();
      const lock = repo.acquireAgentRunLock(familyId, "weekly_pipeline");
      if (!lock) return sendJson(res, 409, { error: "Weekly run is already in progress for this family." });
      try {
        const run = await runWeeklyPipeline(repo, familyId, (event) => realtime.publish(familyId, event));
        realtime.publish(familyId, { type: "dashboard_changed", message: run.summary, data: repo.dashboard(familyId) });
        return sendJson(res, 200, { run });
      } finally {
        repo.releaseAgentRunLock(familyId, "weekly_pipeline");
      }
    }

    if (url.pathname === "/api/dashboard" && req.method === "GET") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      return sendJson(res, 200, repo.dashboard(currentUser.familyId, currentUser));
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      return sendJson(res, 200, repo.getSettings(currentUser.familyId));
    }

    if (url.pathname === "/api/settings" && (req.method === "PATCH" || req.method === "PUT")) {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const missingAssignments = usersMissingProfileAssignments(body, repo.listStudents(currentUser.familyId));
      if (missingAssignments.length) {
        return sendJson(res, 400, {
          error: `Assign at least one Profile to every non-admin user: ${missingAssignments.join(", ")}.`
        });
      }
      const previousSettings = repo.getSettings(currentUser.familyId);
      const settings = repo.updateSettings(body, currentUser.familyId);
      const invites = await inviteNewSettingsUsers(previousSettings, settings, currentUser.familyId, req);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, { type: "dashboard_changed", message: settingsInviteMessage(invites), data: dashboard });
      return sendJson(res, 200, { settings, dashboard, invites });
    }

    if (url.pathname === "/api/settings/sync" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const settingsInput = body?.settings ?? body;
      const missingAssignments = usersMissingProfileAssignments(settingsInput, repo.listStudents(currentUser.familyId));
      if (missingAssignments.length) {
        return sendJson(res, 400, {
          error: `Assign at least one Profile to every non-admin user: ${missingAssignments.join(", ")}.`
        });
      }
      const settings = repo.updateSettings(settingsInput, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, { type: "dashboard_changed", message: "Settings restored.", data: dashboard });
      return sendJson(res, 200, { settings, dashboard, invites: [] });
    }

    const settingsInviteMatch = url.pathname.match(/^\/api\/settings\/users\/([^/]+)\/invite$/);
    if (settingsInviteMatch && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const userId = decodeURIComponent(settingsInviteMatch[1]);
      const settings = repo.getSettings(currentUser.familyId);
      const settingsUser = settings.users.find((item) => item.id === userId);
      if (!settingsUser) return sendJson(res, 404, { error: "Settings user not found." });
      if (settingsUser.status !== "active") return sendJson(res, 400, { error: "Only active users can receive invites." });
      const invite = await sendSettingsUserInvite(settingsUser, currentUser.familyId, req);
      return sendJson(res, 200, { invite, dashboard: repo.dashboard(currentUser.familyId, currentUser) });
    }

    if (url.pathname === "/api/students" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const profile = mergeStudentProfile(blankStudentProfile(), body);
      const student = repo.createStudent(profile, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, { type: "dashboard_changed", message: "Student profile added.", data: dashboard });
      return sendJson(res, 201, { student, dashboard });
    }

    if (url.pathname === "/api/students/sync" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const students = normalizeStudentSync(body.students, currentUser.familyId);
      if (!students.length) return sendJson(res, 400, { error: "At least one student Profile is required." });
      const syncedStudents = repo.syncStudents(students, currentUser.familyId);
      for (const student of syncedStudents) refreshStudentPlans(student.id, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: "Student Profiles restored.",
        data: dashboard
      });
      return sendJson(res, 200, { students: syncedStudents, dashboard });
    }

    const studentMatch = url.pathname.match(/^\/api\/students\/([^/]+)$/);
    if (studentMatch && (req.method === "PATCH" || req.method === "PUT")) {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const student = repo.updateStudent(studentMatch[1], body, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, { type: "dashboard_changed", message: "Student profile updated.", data: dashboard });
      return sendJson(res, 200, { student, dashboard });
    }

    if (studentMatch && req.method === "DELETE") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      if (repo.listStudents(currentUser.familyId).length <= 1) {
        return sendJson(res, 400, { error: "Add another Profile before removing this one." });
      }
      const student = repo.deleteStudent(decodeURIComponent(studentMatch[1]), currentUser.familyId);
      if (!student) return sendJson(res, 404, { error: "Student profile not found" });
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: `${student.profile.preferredName} removed.`,
        data: dashboard
      });
      return sendJson(res, 200, { student, dashboard });
    }

    const applicationPlanStudentMatch = url.pathname.match(/^\/api\/application-plans\/([^/]+)\/student$/);
    if (applicationPlanStudentMatch && (req.method === "PATCH" || req.method === "PUT")) {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const plan = repo.listApplicationPlans(currentUser.familyId).find((item) => item.id === applicationPlanStudentMatch[1]);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      const student = repo.getStudent(String(body.studentId ?? ""), currentUser.familyId);
      if (!student) return sendJson(res, 404, { error: "Student profile not found" });
      const scholarship = repo.getScholarship(plan.scholarshipId, currentUser.familyId);
      if (!scholarship) return sendJson(res, 404, { error: "Scholarship not found" });
      const updatedPlan = repo.replaceApplicationPlan(
        plan.id,
        prepareApplicationPlan(student, scholarship, repo.listDocuments(currentUser.familyId)),
        currentUser.familyId
      );
      repo.refreshApplicationPlanApprovalSummaries(plan.id, scholarship.title, student.profile.preferredName, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: `${student.profile.preferredName}'s profile selected for ${scholarship.title}.`,
        data: dashboard
      });
      return sendJson(res, 200, { applicationPlan: updatedPlan, dashboard });
    }

    if (url.pathname === "/api/documents" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const student = repo.getStudent(String(body.studentId ?? ""), currentUser.familyId);
      if (!student) return sendJson(res, 404, { error: "Student profile not found" });
      const document = repo.createDocument(
        {
          studentId: student.id,
          type: normalizeDocumentType(body.type),
          name: String(body.name ?? "").trim(),
          path: String(body.path ?? `browser-local://${body.type ?? "other"}/${body.name ?? "document"}`).trim(),
          status: normalizeDocumentStatus(body.status)
        },
        currentUser.familyId
      );
      refreshStudentPlans(student.id, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: `${document.type} added for ${student.profile.preferredName}.`,
        data: dashboard
      });
      return sendJson(res, 201, { document, dashboard });
    }

    if (url.pathname === "/api/documents/sync" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const documents = normalizeDocumentSync(body.documents, currentUser.familyId);
      const affectedStudents = new Set<string>();
      for (const document of documents) {
        repo.upsertDocument(document, currentUser.familyId);
        affectedStudents.add(document.studentId);
      }
      for (const studentId of affectedStudents) refreshStudentPlans(studentId, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: `${documents.length} saved document${documents.length === 1 ? "" : "s"} synced.`,
        data: dashboard
      });
      return sendJson(res, 200, { documents, dashboard });
    }

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (documentMatch && (req.method === "PATCH" || req.method === "PUT")) {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const documentId = decodeURIComponent(documentMatch[1]);
      const existing = repo.listDocuments(currentUser.familyId).find((document) => document.id === documentId);
      if (!existing) return sendJson(res, 404, { error: "Document not found" });
      const body = await readJson(req);
      const studentId = String(body.studentId ?? existing.studentId).trim();
      const student = repo.getStudent(studentId, currentUser.familyId);
      if (!student) return sendJson(res, 404, { error: "Student profile not found" });
      const updated = repo.updateDocument(
        documentId,
        {
          studentId,
          type: body.type === undefined ? existing.type : normalizeDocumentType(body.type),
          name: String(body.name ?? existing.name).trim(),
          path: String(body.path ?? existing.path).trim(),
          status: body.status === undefined ? existing.status : normalizeDocumentStatus(body.status)
        },
        currentUser.familyId
      );
      if (!updated) return sendJson(res, 404, { error: "Document not found" });
      refreshStudentPlans(existing.studentId, currentUser.familyId);
      if (updated.studentId !== existing.studentId) refreshStudentPlans(updated.studentId, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: `${updated.name} linked to ${student.profile.preferredName}.`,
        data: dashboard
      });
      return sendJson(res, 200, { document: updated, dashboard });
    }

    if (documentMatch && req.method === "DELETE") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const deleted = repo.deleteDocument(decodeURIComponent(documentMatch[1]), currentUser.familyId);
      if (!deleted) return sendJson(res, 404, { error: "Document not found" });
      refreshStudentPlans(deleted.studentId, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: `${deleted.name} removed.`,
        data: dashboard
      });
      return sendJson(res, 200, { document: deleted, dashboard });
    }

    if (url.pathname === "/api/runs/weekly" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const run = await runWeeklyPipeline(repo, currentUser.familyId, (event) => realtime.publish(currentUser.familyId, event));
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, { type: "dashboard_changed", message: run.summary, data: dashboard });
      return sendJson(res, 200, { run, dashboard });
    }

    const approvalStartMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve-and-start$/);
    if (approvalStartMatch && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const approvalId = decodeURIComponent(approvalStartMatch[1]);
      const existingApproval = repo.listApprovals(currentUser.familyId).find((item) => item.id === approvalId);
      if (!existingApproval) return sendJson(res, 404, { error: "Approval not found" });
      if (existingApproval.actionType !== "portal_submit" || existingApproval.targetType !== "application_plan") {
        return sendJson(res, 400, { error: "Only application review approvals can start autofill." });
      }
      if (existingApproval.status === "rejected" || existingApproval.status === "superseded") {
        return sendJson(res, 409, { error: "This approval is no longer active." });
      }
      const approval =
        existingApproval.status === "approved"
          ? existingApproval
          : repo.decideApproval(approvalId, "approved", body.note ?? "Approved and started autofill.", currentUser.familyId);
      const plan = repo.getApplicationPlan(approval.targetId, currentUser.familyId);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      const refreshed = refreshSubmissionSession(plan.id, currentUser.familyId);
      if (refreshed.status === "blocked") {
        const dashboard = repo.dashboard(currentUser.familyId, currentUser);
        realtime.publish(currentUser.familyId, {
          type: "dashboard_changed",
          message: "Approved, but Chrome autofill is blocked until the remaining approvals are complete.",
          data: dashboard
        });
        return sendJson(res, 200, {
          approval,
          submissionSession: refreshed,
          dashboard,
          launchUrl: refreshed.launchUrl,
          started: false,
          autofill: {
            status: "blocked",
            sessionStatus: refreshed.status,
            blockers: refreshed.blockers,
            message: "Required approvals are still missing."
          }
        });
      }

      let session = repo.updateSubmissionSessionStatus(refreshed.id, "filling", currentUser.familyId, []);
      const { companionToken, token } = repo.createCompanionToken(session.id, currentUser.familyId);
      let autofill: ChromeAutofillResult = {
        status: "local_companion_ready",
        sessionStatus: "waiting_for_manual_submit",
        launchUrl: session.launchUrl,
        filledFields: [] as string[],
        skippedFields: [] as string[],
        blockers: [] as string[],
        message: "Local companion token created. Run the local Chrome companion to autofill this application."
      };
      if (body.runLocalAutofill !== false) {
        autofill = await startChromeAutofill({
          session,
          plan,
          documents: repo.listDocuments(currentUser.familyId),
          baseDir
        });
      }
      session = repo.updateSubmissionSessionStatus(
        session.id,
        autofill.sessionStatus,
        currentUser.familyId,
        autofill.blockers
      );
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: autofill.message,
        data: dashboard
      });
      return sendJson(res, 200, {
        approval,
        submissionSession: session,
        dashboard,
        launchUrl: session.launchUrl,
        started: true,
        companionToken: {
          id: companionToken.id,
          submissionSessionId: companionToken.submissionSessionId,
          expiresAt: companionToken.expiresAt
        },
        token,
        autofill,
        chromeProfileLabel: session.chromeProfileLabel,
        instructions: chromeSubmissionInstructions(session.chromeProfileLabel)
      });
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (approvalMatch && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      if (body.status !== "approved" && body.status !== "rejected") {
        return sendJson(res, 400, { error: "status must be approved or rejected" });
      }
      const approval = repo.decideApproval(approvalMatch[1], body.status, body.note ?? "", currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, { type: "dashboard_changed", message: `Approval ${body.status}.`, data: dashboard });
      return sendJson(res, 200, { approval, dashboard });
    }

    if (url.pathname === "/api/submission-sessions" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const plan = repo.getApplicationPlan(String(body.applicationPlanId ?? ""), currentUser.familyId);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      const session = refreshSubmissionSession(plan.id, currentUser.familyId);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: session.status === "blocked" ? "Chrome submission session needs review before it can start." : "Chrome submission session created.",
        data: dashboard
      });
      return sendJson(res, 201, { submissionSession: session, dashboard });
    }

    const submissionStartMatch = url.pathname.match(/^\/api\/submission-sessions\/([^/]+)\/start$/);
    if (submissionStartMatch && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const existing = repo.getSubmissionSession(decodeURIComponent(submissionStartMatch[1]), currentUser.familyId);
      if (!existing) return sendJson(res, 404, { error: "Submission session not found" });
      const refreshed = refreshSubmissionSession(existing.applicationPlanId, currentUser.familyId);
      if (refreshed.status === "blocked") {
        const dashboard = repo.dashboard(currentUser.familyId, currentUser);
        realtime.publish(currentUser.familyId, {
          type: "dashboard_changed",
          message: "Chrome submission session is blocked until required approvals are complete.",
          data: dashboard
        });
        return sendJson(res, 409, {
          error: "Required approvals are still missing.",
          submissionSession: refreshed,
          dashboard
        });
      }
      const plan = repo.getApplicationPlan(refreshed.applicationPlanId, currentUser.familyId);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      let session = repo.updateSubmissionSessionStatus(refreshed.id, "filling", currentUser.familyId, []);
      const { companionToken, token } = repo.createCompanionToken(session.id, currentUser.familyId);
      let autofill: ChromeAutofillResult = {
        status: "local_companion_ready",
        sessionStatus: "waiting_for_manual_submit",
        launchUrl: session.launchUrl,
        filledFields: [] as string[],
        skippedFields: [] as string[],
        blockers: [] as string[],
        message: "Local companion token created. Run the local Chrome companion to autofill this application."
      };
      if (body.runLocalAutofill !== false) {
        autofill = await startChromeAutofill({
          session,
          plan,
          documents: repo.listDocuments(currentUser.familyId),
          baseDir
        });
      }
      session = repo.updateSubmissionSessionStatus(session.id, autofill.sessionStatus, currentUser.familyId, autofill.blockers);
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: autofill.message,
        data: dashboard
      });
      return sendJson(res, 200, {
        submissionSession: session,
        dashboard,
        launchUrl: session.launchUrl,
        chromeProfileLabel: session.chromeProfileLabel,
        companionToken: {
          id: companionToken.id,
          submissionSessionId: companionToken.submissionSessionId,
          expiresAt: companionToken.expiresAt
        },
        token,
        autofill,
        instructions: chromeSubmissionInstructions(session.chromeProfileLabel)
      });
    }

    const submissionCompanionMatch = url.pathname.match(/^\/api\/submission-sessions\/([^/]+)\/companion-token$/);
    if (submissionCompanionMatch && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const sessionId = decodeURIComponent(submissionCompanionMatch[1]);
      const session = repo.getSubmissionSession(sessionId, currentUser.familyId);
      if (!session) return sendJson(res, 404, { error: "Submission session not found" });
      const { companionToken, token } = repo.createCompanionToken(session.id, currentUser.familyId);
      return sendJson(res, 201, {
        companionToken: {
          id: companionToken.id,
          submissionSessionId: companionToken.submissionSessionId,
          expiresAt: companionToken.expiresAt
        },
        token
      });
    }

    const submissionConfirmMatch = url.pathname.match(/^\/api\/submission-sessions\/([^/]+)\/confirm-submitted$/);
    if (submissionConfirmMatch && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const sessionId = decodeURIComponent(submissionConfirmMatch[1]);
      const existing = repo.getSubmissionSession(sessionId, currentUser.familyId);
      if (!existing) return sendJson(res, 404, { error: "Submission session not found" });
      if (existing.status !== "waiting_for_manual_submit" && existing.status !== "submitted") {
        return sendJson(res, 409, { error: "Start the Chrome session before recording manual submission proof." });
      }
      if (!hasApprovedPlanAction(existing.applicationPlanId, "portal_submit", currentUser.familyId)) {
        return sendJson(res, 403, { error: "Application review approval is required before recording submission proof." });
      }
      const body = await readJson(req);
      const session = repo.confirmSubmissionSession(
        sessionId,
        {
          confirmationText: String(body.confirmationText ?? ""),
          screenshotName: cleanOptionalText(body.screenshotName),
          screenshotPath: cleanOptionalText(body.screenshotPath)
        },
        currentUser.familyId
      );
      const dashboard = repo.dashboard(currentUser.familyId, currentUser);
      realtime.publish(currentUser.familyId, {
        type: "dashboard_changed",
        message: "Submission proof recorded and scholarship marked submitted.",
        data: dashboard
      });
      return sendJson(res, 200, { submissionSession: session, dashboard });
    }

    if (url.pathname === "/api/browser-sessions" && req.method === "POST") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      const body = await readJson(req);
      const plan = repo.listApplicationPlans(currentUser.familyId).find((item) => item.id === body.applicationPlanId);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      const session = createAssistedBrowserSession(plan);
      repo.audit("agent", "browser_session_prepared", "application_plan", plan.id, {
        steps: session.steps.length,
        blockedActions: session.blockedActions
      }, currentUser.familyId);
      realtime.publish(currentUser.familyId, {
        type: "agent_progress",
        message: "Safe browser session prepared. Review stop is active.",
        data: { applicationPlanId: plan.id }
      });
      return sendJson(res, 200, session);
    }

    if (url.pathname === "/api/export" && req.method === "GET") {
      const currentUser = requireUser(user, res);
      if (!currentUser) return;
      return sendJson(res, 200, repo.dashboard(currentUser.familyId, currentUser));
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Scholarship Agent App running at http://${HOST}:${PORT}`);
  if (repo.getPortalCredentialsHint().password === "change-me-now") {
    console.log(`Portal login: ${repo.getPortalCredentialsHint().email} / ${repo.getPortalCredentialsHint().password}`);
    console.log("Set PORTAL_ADMIN_EMAIL and PORTAL_ADMIN_PASSWORD before hosting this anywhere beyond your machine.");
  }
});

function serveStatic(requestPath: string, res: ServerResponse) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return sendJson(res, 404, { error: "Not found" });
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location });
  res.end();
}

function safeNextPath(next: string | null): string | undefined {
  if (!next) return undefined;
  if (!next.startsWith("/") || next.startsWith("//")) return undefined;
  return next;
}

function requireUser(user: PortalUser | undefined, res: ServerResponse): PortalUser | undefined {
  if (user) return user;
  sendJson(res, 401, { error: "Please sign in first.", loginUrl: "/login" });
  return undefined;
}

function usersMissingProfileAssignments(input: Partial<SettingsData>, students: Student[]): string[] {
  const users = Array.isArray(input?.users) ? input.users : [];
  const availableProfileIds = new Set(students.map((student) => student.id));
  return users
    .filter((user) => {
      if (user?.role === "Admin") return false;
      const assignedIds = Array.isArray(user?.profileIds) ? user.profileIds : [];
      return !assignedIds.some((id) => availableProfileIds.has(String(id)));
    })
    .map((user) => String(user?.name || user?.email || "Unnamed user"));
}

async function inviteNewSettingsUsers(
  previousSettings: SettingsData,
  nextSettings: SettingsData,
  familyId: string,
  req: IncomingMessage
): Promise<InviteEmailResult[]> {
  const existingEmails = new Set(previousSettings.users.map((user) => user.email.toLowerCase()));
  const results: InviteEmailResult[] = [];
  for (const user of nextSettings.users) {
    if (existingEmails.has(user.email.toLowerCase()) || user.status !== "active") continue;
    results.push(await sendSettingsUserInvite(user, familyId, req));
  }
  return results;
}

async function sendSettingsUserInvite(
  user: SettingsData["users"][number],
  familyId: string,
  req: IncomingMessage
): Promise<InviteEmailResult> {
  const family = repo.getFamily(familyId);
  const { invite, token } = repo.createPortalInviteForSettingsUser(user, familyId);
  const inviteUrl = `${portalBaseUrl(req)}/invite.html?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const result = await sendPortalInviteEmail({
    email: user.email,
    displayName: user.name,
    familyName: family?.name ?? "your family",
    role: user.role,
    inviteUrl
  });
  repo.recordPortalInviteDelivery(invite.id, { ...result, inviteUrl }, familyId);
  repo.audit("parent", `portal_invite_email_${result.status}`, "user", user.id, {
    email: user.email,
    status: result.status,
    providerMessageId: result.providerMessageId ?? "",
    error: result.error ?? ""
  }, familyId);
  return result;
}

function settingsInviteMessage(invites: InviteEmailResult[]): string {
  if (!invites.length) return "Settings updated.";
  const manual = invites.filter((invite) => invite.status === "manual").length;
  const sent = invites.filter((invite) => invite.status === "sent").length;
  const unsent = invites.length - sent;
  if (manual && manual === invites.length) return `${manual} manual invite link${manual === 1 ? "" : "s"} ready.`;
  if (sent && !unsent) return `${sent} invite email${sent === 1 ? "" : "s"} sent.`;
  if (sent && unsent) return `${sent} invite email${sent === 1 ? "" : "s"} sent; ${unsent} invite${unsent === 1 ? "" : "s"} need email setup.`;
  return "Invite link created. Add RESEND_API_KEY to send invite emails automatically.";
}

function portalBaseUrl(req: IncomingMessage): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader ?? "http";
  const host = req.headers.host ?? `${HOST}:${PORT}`;
  return `${proto}://${host}`;
}

function isAuthorizedCron(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${CRON_SECRET}`) return true;
  return req.headers["x-cron-secret"] === CRON_SECRET;
}

function getBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function refreshStudentPlans(studentId: string, familyId: string) {
  const student = repo.getStudent(studentId, familyId);
  if (!student) return;
  for (const plan of repo.listApplicationPlans(familyId).filter((item) => item.studentId === studentId)) {
    const scholarship = repo.getScholarship(plan.scholarshipId, familyId);
    if (!scholarship) continue;
    repo.replaceApplicationPlan(plan.id, prepareApplicationPlan(student, scholarship, repo.listDocuments(familyId)), familyId);
  }
}

function refreshSubmissionSession(planId: string, familyId: string) {
  const plan = repo.getApplicationPlan(planId, familyId);
  if (!plan) throw new Error(`Application plan not found: ${planId}`);
  const scholarship = repo.getScholarship(plan.scholarshipId, familyId);
  const draft = createChromeSubmissionSessionDraft(plan, repo.listApprovals(familyId), scholarship);
  return repo.createSubmissionSession(draft, familyId);
}

function hasApprovedPlanAction(planId: string, actionType: Approval["actionType"], familyId: string): boolean {
  return repo
    .listApprovals(familyId)
    .some(
      (approval) =>
        approval.actionType === actionType &&
        approval.targetType === "application_plan" &&
        approval.targetId === planId &&
        approval.status === "approved"
    );
}

function chromeSubmissionInstructions(chromeProfileLabel: string): string[] {
  return [
    `Use the dedicated ${chromeProfileLabel} Chrome profile for portal logins.`,
    "Log in manually if the scholarship portal asks.",
    "Only fill known profile fields and stage documents with approved upload permissions.",
    "Stop at the final review or submit screen. The app never clicks final submit."
  ];
}

function safeCompanionStudent(student: Student | undefined) {
  if (!student) return undefined;
  return {
    id: student.id,
    preferredName: student.profile.preferredName,
    graduationYear: student.profile.graduationYear,
    schoolState: student.profile.schoolState
  };
}

function safeCompanionScholarship(scholarship: Scholarship | undefined) {
  if (!scholarship) return undefined;
  return {
    id: scholarship.id,
    title: scholarship.title,
    provider: scholarship.provider,
    url: scholarship.url,
    award: scholarship.award,
    deadline: scholarship.deadline
  };
}

function safeCompanionDocuments(documents: DocumentRecord[]) {
  return documents.map((document) => ({
    id: document.id,
    type: document.type,
    category: document.category ?? document.type,
    name: document.name,
    status: document.status,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    uploadedAt: document.uploadedAt
  }));
}

function cleanOptionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function normalizeDocumentType(value: unknown): DocumentRecord["type"] {
  const raw = String(value ?? "other");
  if (["resume", "transcript", "recommendation", "essay", "other"].includes(raw)) return raw as DocumentRecord["type"];
  return "other";
}

function normalizeDocumentStatus(value: unknown): DocumentRecord["status"] {
  const raw = String(value ?? "available");
  if (["available", "missing", "needs_update"].includes(raw)) return raw as DocumentRecord["status"];
  return "available";
}

function normalizeDocumentSync(input: unknown, familyId: string): DocumentRecord[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeDocumentRecord(item, familyId))
    .filter((document): document is DocumentRecord => Boolean(document));
}

function normalizeStudentSync(input: unknown, familyId: string): Student[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input
    .map((item: any) => {
      const id = String(item?.id ?? "").trim() || randomUUID();
      if (seen.has(id)) return undefined;
      seen.add(id);
      const profileInput = item?.profile && typeof item.profile === "object" ? item.profile : item;
      const profile = mergeStudentProfile(blankStudentProfile(), profileInput ?? {});
      const graduationYear = Number(profile.graduationYear);
      if (!profile.preferredName || !profile.legalName || !profile.schoolState || !Number.isFinite(graduationYear)) {
        return undefined;
      }
      const normalizedProfile = { ...profile, graduationYear };
      return {
        id,
        familyId,
        name: normalizedProfile.preferredName,
        graduationYear,
        schoolState: normalizedProfile.schoolState,
        profile: normalizedProfile,
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString()
      };
    })
    .filter((student): student is Student => Boolean(student));
}

function normalizeDocumentRecord(input: any, familyId: string): DocumentRecord | undefined {
  const studentId = String(input?.studentId ?? "").trim();
  if (!repo.getStudent(studentId, familyId)) return undefined;
  const name = String(input?.name ?? "").trim();
  if (!name) return undefined;
  const type = normalizeDocumentType(input?.type);
  return {
    id: String(input?.id ?? "").trim() || randomUUID(),
    familyId,
    studentId,
    type,
    name,
    path: String(input?.path ?? `browser-local://${type}/${name}`).trim(),
    status: normalizeDocumentStatus(input?.status),
    uploadedAt: typeof input?.uploadedAt === "string" ? input.uploadedAt : new Date().toISOString()
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim().length ? JSON.parse(raw) : {};
}

function blankStudentProfile(): StudentProfile {
  return {
    preferredName: "",
    legalName: "",
    firstName: "",
    lastName: "",
    email: "",
    gender: "",
    dateOfBirth: "",
    graduationYear: new Date().getFullYear() + 1,
    graduationMonth: "June",
    gradeLevel: "junior",
    schoolState: "",
    highSchoolName: "",
    citizenship: "unknown",
    financialNeed: "unknown",
    intendedMajors: [],
    collegesConsidering: [],
    activities: [],
    awards: [],
    streetAddress: "",
    city: "",
    postalCode: "",
    constraints: [],
    essayInterview: {
      proudMoment: "",
      communityImpact: "",
      challenge: "",
      futureGoal: "",
      voiceNotes: ""
    }
  };
}

function mergeStudentProfile(base: StudentProfile, input: Partial<StudentProfile>): StudentProfile {
  return {
    preferredName: input.preferredName ?? base.preferredName,
    legalName: input.legalName ?? base.legalName,
    firstName: String(input.firstName ?? base.firstName ?? "").trim(),
    lastName: String(input.lastName ?? base.lastName ?? "").trim(),
    email: String(input.email ?? base.email ?? "").trim().toLowerCase(),
    gender: String(input.gender ?? base.gender ?? "").trim(),
    dateOfBirth: String(input.dateOfBirth ?? base.dateOfBirth ?? "").trim(),
    graduationYear: input.graduationYear ?? base.graduationYear,
    graduationMonth: String(input.graduationMonth ?? base.graduationMonth ?? "").trim(),
    gradeLevel: input.gradeLevel ?? base.gradeLevel,
    schoolState: input.schoolState ?? base.schoolState,
    highSchoolName: String(input.highSchoolName ?? base.highSchoolName ?? "").trim(),
    gpa: input.gpa === null ? undefined : input.gpa ?? base.gpa,
    citizenship: input.citizenship ?? base.citizenship,
    firstGeneration: input.firstGeneration === null ? undefined : input.firstGeneration ?? base.firstGeneration,
    financialNeed: input.financialNeed ?? base.financialNeed,
    intendedMajors: input.intendedMajors ?? base.intendedMajors,
    collegesConsidering: input.collegesConsidering ?? base.collegesConsidering ?? [],
    activities: input.activities ?? base.activities,
    serviceHours: input.serviceHours === null ? undefined : input.serviceHours ?? base.serviceHours,
    awards: input.awards ?? base.awards,
    streetAddress: String(input.streetAddress ?? base.streetAddress ?? "").trim(),
    city: String(input.city ?? base.city ?? "").trim(),
    postalCode: String(input.postalCode ?? base.postalCode ?? "").trim(),
    constraints: input.constraints ?? base.constraints,
    essayInterview: {
      ...base.essayInterview,
      ...(input.essayInterview ?? {})
    }
  };
}
