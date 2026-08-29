import { randomUUID } from "node:crypto";

const SESSION_COOKIE = "scholarship_session";
const SESSION_VALUE = "vercel-preview-session";
const FAMILY_ID = "family_vercel_preview";
const USER_ID = "user_vercel_preview";
const TOP_REVIEW_MATCH_LIMIT = 5;
const SETTINGS_ROLES = ["Admin", "Employee", "Guest", "Viewer"];
const SETTINGS_CAPABILITIES = [
  "manageSettings",
  "manageUsers",
  "manageProfiles",
  "manageScholarships",
  "prepareApplications",
  "approveActions",
  "viewAudit"
];

globalThis.__scholarshipPortalState ??= null;

export default async function handler(req, res) {
  const url = new URL(req.url ?? "/api", "https://scholarship-agent.vercel.app");
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (pathname === "/api/auth/login" && method === "POST") {
      const body = normalizeBody(req.body);
      if (!isValidLogin(String(body.email ?? ""), String(body.password ?? ""))) {
        return sendJson(res, 401, { error: "Email or password was not recognized." });
      }
      setSessionCookie(res);
      return sendJson(res, 200, { user: publicUser(state().user) });
    }

    if (pathname === "/api/auth/accept-invite" && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const accepted = acceptPortalInvitePreview(data, cleanText(body.token), String(body.password ?? ""));
      if (!accepted.ok) return sendJson(res, 400, { error: accepted.error });
      setSessionCookie(res);
      return sendJson(res, 200, { user: publicUser(accepted.user) });
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/cron/weekly" && (method === "POST" || method === "GET")) {
      if (!isAuthorizedCron(req)) return sendJson(res, 401, { error: "Missing or invalid cron secret." });
      const data = state();
      const lock = acquirePreviewRunLock(data, FAMILY_ID, "weekly_pipeline");
      if (!lock) return sendJson(res, 409, { error: "Weekly run is already in progress for this family." });
      try {
        const run = runWeeklyPipelinePreview(data);
        return sendJson(res, 200, { run });
      } finally {
        releasePreviewRunLock(data, FAMILY_ID, "weekly_pipeline");
      }
    }

    if (pathname === "/api/companion/submission-session" && method === "GET") {
      const data = state();
      const companion = consumeCompanionTokenPreview(data, getBearerToken(req));
      if (!companion) return sendJson(res, 401, { error: "Companion token is invalid, expired, or already used." });
      const session = data.submissionSessions.find((item) => item.id === companion.submissionSessionId);
      if (!session) return sendJson(res, 404, { error: "Submission session not found." });
      const applicationPlan = data.applicationPlans.find((item) => item.id === session.applicationPlanId);
      if (!applicationPlan) return sendJson(res, 404, { error: "Application plan not found." });
      const student = data.students.find((item) => item.id === session.studentId);
      const scholarship = data.scholarships.find((item) => item.id === session.scholarshipId);
      return sendJson(res, 200, {
        submissionSession: session,
        applicationPlan,
        student: safeCompanionStudent(student),
        scholarship: safeCompanionScholarship(scholarship),
        documents: safeCompanionDocuments(data.documents.filter((document) => document.studentId === session.studentId))
      });
    }

    if (!hasSession(req)) {
      return sendJson(res, 401, { error: "Please sign in first.", loginUrl: "/login" });
    }

    if (pathname === "/api/me" && method === "GET") {
      const data = state();
      return sendJson(res, 200, { user: publicUser(data.user), family: data.family, runtime: "vercel-preview" });
    }

    if (pathname === "/api/events" && method === "GET") {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", message: "Vercel preview API connected." })}\n\n`);
      const heartbeat = setInterval(() => {
        res.write(`: keep-alive ${new Date().toISOString()}\n\n`);
      }, 25000);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        res.end();
      };
      req.on?.("close", close);
      setTimeout(close, 55000);
      return;
    }

    if (pathname === "/api/dashboard" && method === "GET") {
      return sendJson(res, 200, dashboard(state()));
    }

    if (pathname === "/api/settings" && method === "GET") {
      return sendJson(res, 200, state().settings);
    }

    if (pathname === "/api/settings" && (method === "PATCH" || method === "PUT")) {
      const data = state();
      const previousSettings = data.settings;
      const nextSettings = normalizeSettings(normalizeBody(req.body), data.settings, data.user.email);
      const missingAssignments = usersMissingProfileAssignments(nextSettings, data.students);
      if (missingAssignments.length) {
        return sendJson(res, 400, {
          error: `Assign at least one Profile to every non-admin user: ${missingAssignments.join(", ")}.`
        });
      }
      data.settings = nextSettings;
      data.settings.updatedAt = new Date().toISOString();
      audit(data, "parent", "settings_updated", "settings", FAMILY_ID, {
        users: data.settings.users.length,
        customBoxes: data.settings.customBoxes.length,
        customFields: data.settings.customFields.length,
        customTabs: data.settings.customTabs.length
      });
      const invites = await inviteNewSettingsUsersPreview(data, previousSettings, data.settings, req);
      return sendJson(res, 200, { settings: data.settings, dashboard: dashboard(data), invites });
    }

    if (pathname === "/api/settings/sync" && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const nextSettings = normalizeSettings(body.settings ?? body, data.settings, data.user.email);
      const missingAssignments = usersMissingProfileAssignments(nextSettings, data.students);
      if (missingAssignments.length) {
        return sendJson(res, 400, {
          error: `Assign at least one Profile to every non-admin user: ${missingAssignments.join(", ")}.`
        });
      }
      data.settings = nextSettings;
      data.settings.updatedAt = new Date().toISOString();
      audit(data, "parent", "settings_synced", "settings", FAMILY_ID, {
        users: data.settings.users.length,
        customBoxes: data.settings.customBoxes.length,
        customFields: data.settings.customFields.length,
        customTabs: data.settings.customTabs.length
      });
      return sendJson(res, 200, { settings: data.settings, dashboard: dashboard(data), invites: [] });
    }

    const settingsInviteMatch = pathname.match(/^\/api\/settings\/users\/([^/]+)\/invite$/);
    if (settingsInviteMatch && method === "POST") {
      const data = state();
      const userId = decodeURIComponent(settingsInviteMatch[1]);
      const settingsUser = data.settings.users.find((item) => item.id === userId);
      if (!settingsUser) return sendJson(res, 404, { error: "Settings user not found." });
      if (settingsUser.status !== "active") return sendJson(res, 400, { error: "Only active users can receive invites." });
      const invite = await sendSettingsUserInvitePreview(data, settingsUser, req);
      return sendJson(res, 200, { invite, dashboard: dashboard(data) });
    }

    if (pathname === "/api/students" && method === "POST") {
      const data = state();
      const profile = mergeStudentProfile(blankStudentProfile(), normalizeBody(req.body));
      const student = studentFromProfile(profile);
      data.students.push(student);
      audit(data, "parent", "student_created", "student", student.id, { name: profile.preferredName });
      return sendJson(res, 201, { student, dashboard: dashboard(data) });
    }

    if (pathname === "/api/students/sync" && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const students = normalizeStudentSync(body.students);
      if (!students.length) return sendJson(res, 400, { error: "At least one student profile is required." });
      data.students = students;
      reconcileDocumentsForStudents(data);
      audit(data, "parent", "student_profiles_synced", "student", "client_profiles", {
        count: students.length
      });
      return sendJson(res, 200, { students, dashboard: dashboard(data) });
    }

    if (pathname === "/api/documents" && method === "POST") {
      const data = state();
      const document = normalizeDocumentRecord(normalizeBody(req.body), data);
      if (!document) return sendJson(res, 400, { error: "Document needs a student, type, and file name." });
      upsertDocument(data, document);
      refreshPlansForDocumentStudent(data, document.studentId);
      audit(data, "parent", "document_registered", "document", document.id, {
        type: document.type,
        name: document.name,
        studentId: document.studentId
      });
      return sendJson(res, 201, { document, dashboard: dashboard(data) });
    }

    if (pathname === "/api/documents/sync" && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const documents = normalizeDocumentSync(body.documents, data);
      data.documents = documents;
      for (const student of data.students) refreshPlansForDocumentStudent(data, student.id);
      audit(data, "parent", "documents_synced", "document", "client_documents", {
        count: documents.length
      });
      return sendJson(res, 200, { documents, dashboard: dashboard(data) });
    }

    const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (documentMatch && (method === "PATCH" || method === "PUT")) {
      const data = state();
      const updated = updateDocument(data, decodeURIComponent(documentMatch[1]), normalizeBody(req.body));
      if (!updated) return sendJson(res, 404, { error: "Document or student profile not found" });
      refreshPlansForDocumentStudent(data, updated.previous.studentId);
      if (updated.document.studentId !== updated.previous.studentId) refreshPlansForDocumentStudent(data, updated.document.studentId);
      audit(data, "parent", "document_updated", "document", updated.document.id, {
        type: updated.document.type,
        name: updated.document.name,
        studentId: updated.document.studentId
      });
      return sendJson(res, 200, { document: updated.document, dashboard: dashboard(data) });
    }

    if (documentMatch && method === "DELETE") {
      const data = state();
      const deleted = deleteDocument(data, decodeURIComponent(documentMatch[1]));
      if (!deleted) return sendJson(res, 404, { error: "Document not found" });
      refreshPlansForDocumentStudent(data, deleted.studentId);
      audit(data, "parent", "document_deleted", "document", deleted.id, {
        type: deleted.type,
        name: deleted.name,
        studentId: deleted.studentId
      });
      return sendJson(res, 200, { document: deleted, dashboard: dashboard(data) });
    }

    const studentMatch = pathname.match(/^\/api\/students\/([^/]+)$/);
    if (studentMatch && (method === "PATCH" || method === "PUT")) {
      const data = state();
      let student = data.students.find((item) => item.id === studentMatch[1]);
      if (!student) {
        const profile = mergeStudentProfile(blankStudentProfile(), normalizeBody(req.body));
        student = studentFromProfile(profile, studentMatch[1]);
        data.students.push(student);
        audit(data, "parent", "student_recovered_from_preview_state", "student", student.id, { name: profile.preferredName });
        return sendJson(res, 200, { student, dashboard: dashboard(data) });
      }
      const profile = mergeStudentProfile(student.profile, normalizeBody(req.body));
      student.name = profile.preferredName;
      student.graduationYear = profile.graduationYear;
      student.schoolState = profile.schoolState;
      student.profile = profile;
      audit(data, "parent", "student_updated", "student", student.id, { name: profile.preferredName });
      return sendJson(res, 200, { student, dashboard: dashboard(data) });
    }

    if (studentMatch && method === "DELETE") {
      const data = state();
      if (data.students.length <= 1) {
        return sendJson(res, 400, { error: "Add another Profile before removing this one." });
      }
      const student = deleteStudentPreview(data, decodeURIComponent(studentMatch[1]));
      if (!student) return sendJson(res, 404, { error: "Student profile not found" });
      audit(data, "parent", "student_deleted", "student", student.id, { name: student.profile.preferredName });
      return sendJson(res, 200, { student, dashboard: dashboard(data) });
    }

    const applicationPlanStudentMatch = pathname.match(/^\/api\/application-plans\/([^/]+)\/student$/);
    if (applicationPlanStudentMatch && (method === "PATCH" || method === "PUT")) {
      const data = state();
      const body = normalizeBody(req.body);
      const plan = data.applicationPlans.find((item) => item.id === applicationPlanStudentMatch[1]);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      const student = data.students.find((item) => item.id === body.studentId);
      if (!student) return sendJson(res, 404, { error: "Student profile not found" });
      const scholarship = data.scholarships.find((item) => item.id === plan.scholarshipId);
      if (!scholarship) return sendJson(res, 404, { error: "Scholarship not found" });
      const prepared = prepareApplicationPlan(student, scholarship, data.documents);
      Object.assign(plan, {
        ...prepared,
        id: plan.id,
        familyId: FAMILY_ID,
        createdAt: plan.createdAt
      });
      for (const approval of data.approvals) {
        if (approval.targetType === "application_plan" && approval.targetId === plan.id && approval.actionType === "portal_submit" && approval.status === "pending") {
          approval.summary = `Review ${scholarship.title} for ${student.profile.preferredName}. The app will not submit without this approval.`;
        }
      }
      audit(data, "parent", "application_plan_profile_selected", "application_plan", plan.id, {
        scholarshipId: scholarship.id,
        studentId: student.id,
        missingFields: plan.missingFields.length
      });
      return sendJson(res, 200, { applicationPlan: plan, dashboard: dashboard(data) });
    }

    if (pathname === "/api/runs/weekly" && method === "POST") {
      const data = state();
      const run = runWeeklyPipelinePreview(data);
      return sendJson(res, 200, { run, dashboard: dashboard(data) });
    }

    const approvalStartMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve-and-start$/);
    if (approvalStartMatch && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const approval = data.approvals.find((item) => item.id === approvalStartMatch[1]);
      if (!approval) return sendJson(res, 404, { error: "Approval not found" });
      if (approval.actionType !== "portal_submit" || approval.targetType !== "application_plan") {
        return sendJson(res, 400, { error: "Only application review approvals can start autofill." });
      }
      if (approval.status === "rejected" || approval.status === "superseded") {
        return sendJson(res, 409, { error: "This approval is no longer active." });
      }
      if (approval.status !== "approved") {
        approval.status = "approved";
        approval.decidedAt = new Date().toISOString();
        approval.decisionNote = String(body.note ?? "Approved and started autofill.");
        audit(data, "parent", "approval_approved", approval.targetType, approval.targetId, {
          actionType: approval.actionType
        });
      }
      const session = refreshSubmissionSessionPreview(data, approval.targetId);
      if (!session) return sendJson(res, 404, { error: "Application plan not found" });
      if (session.status === "blocked") {
        return sendJson(res, 200, {
          approval,
          submissionSession: session,
          dashboard: dashboard(data),
          launchUrl: session.launchUrl,
          started: false,
          autofill: {
            status: "blocked",
            sessionStatus: session.status,
            blockers: session.blockers,
            message: "Required approvals are still missing."
          }
        });
      }
      session.status = "waiting_for_manual_submit";
      session.updatedAt = new Date().toISOString();
      const { companionToken, token } = createCompanionTokenPreview(data, session.id);
      audit(data, "agent", "chrome_submission_session_started", "submission_session", session.id, {
        applicationPlanId: session.applicationPlanId,
        chromeProfile: session.chromeProfileLabel,
        launchUrl: session.launchUrl,
        manualSubmitRequired: true,
        localCompanionRequired: true
      });
      return sendJson(res, 200, {
        approval,
        submissionSession: session,
        dashboard: dashboard(data),
        launchUrl: session.launchUrl,
        started: true,
        companionToken: {
          id: companionToken.id,
          submissionSessionId: companionToken.submissionSessionId,
          expiresAt: companionToken.expiresAt
        },
        token,
        autofill: {
          status: "local_companion_ready",
          sessionStatus: session.status,
          launchUrl: session.launchUrl,
          filledFields: [],
          skippedFields: [],
          blockers: [],
          message: "Vercel prepared the session. Run the local/IIS Chrome companion to autofill this application."
        },
        chromeProfileLabel: session.chromeProfileLabel,
        instructions: chromeSubmissionInstructions(session.chromeProfileLabel)
      });
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (approvalMatch && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      if (body.status !== "approved" && body.status !== "rejected") {
        return sendJson(res, 400, { error: "status must be approved or rejected" });
      }
      const approval = data.approvals.find((item) => item.id === approvalMatch[1]);
      if (!approval) return sendJson(res, 404, { error: "Approval not found" });
      approval.status = body.status;
      approval.decidedAt = new Date().toISOString();
      approval.decisionNote = String(body.note ?? "Decision recorded in Vercel preview.");
      audit(data, "parent", `approval_${body.status}`, approval.targetType, approval.targetId, {
        actionType: approval.actionType
      });
      return sendJson(res, 200, { approval, dashboard: dashboard(data) });
    }

    if (pathname === "/api/browser-sessions" && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const plan = data.applicationPlans.find((item) => item.id === body.applicationPlanId);
      if (!plan) return sendJson(res, 404, { error: "Application plan not found" });
      const session = createAssistedBrowserSession(plan);
      audit(data, "agent", "browser_session_prepared", "application_plan", plan.id, {
        steps: session.steps.length,
        blockedActions: session.blockedActions
      });
      return sendJson(res, 200, session);
    }

    if (pathname === "/api/submission-sessions" && method === "POST") {
      const data = state();
      const body = normalizeBody(req.body);
      const result = refreshSubmissionSessionPreview(data, cleanText(body.applicationPlanId));
      if (!result) return sendJson(res, 404, { error: "Application plan not found" });
      audit(data, "agent", "submission_session_created", "application_plan", result.applicationPlanId, {
        status: result.status,
        blockers: result.blockers
      });
      return sendJson(res, 201, { submissionSession: result, dashboard: dashboard(data) });
    }

    const submissionStartMatch = pathname.match(/^\/api\/submission-sessions\/([^/]+)\/start$/);
    if (submissionStartMatch && method === "POST") {
      const data = state();
      const existing = data.submissionSessions.find((item) => item.id === decodeURIComponent(submissionStartMatch[1]));
      if (!existing) return sendJson(res, 404, { error: "Submission session not found" });
      const refreshed = refreshSubmissionSessionPreview(data, existing.applicationPlanId);
      if (!refreshed) return sendJson(res, 404, { error: "Application plan not found" });
      if (refreshed.status === "blocked") {
        return sendJson(res, 409, {
          error: "Required approvals are still missing.",
          submissionSession: refreshed,
          dashboard: dashboard(data)
        });
      }
      refreshed.status = "waiting_for_manual_submit";
      refreshed.updatedAt = new Date().toISOString();
      const { companionToken, token } = createCompanionTokenPreview(data, refreshed.id);
      audit(data, "agent", "chrome_submission_session_started", "submission_session", refreshed.id, {
        applicationPlanId: refreshed.applicationPlanId,
        chromeProfile: refreshed.chromeProfileLabel,
        launchUrl: refreshed.launchUrl,
        manualSubmitRequired: true,
        localCompanionRequired: true
      });
      return sendJson(res, 200, {
        submissionSession: refreshed,
        dashboard: dashboard(data),
        launchUrl: refreshed.launchUrl,
        chromeProfileLabel: refreshed.chromeProfileLabel,
        companionToken: {
          id: companionToken.id,
          submissionSessionId: companionToken.submissionSessionId,
          expiresAt: companionToken.expiresAt
        },
        token,
        autofill: {
          status: "local_companion_ready",
          sessionStatus: refreshed.status,
          launchUrl: refreshed.launchUrl,
          filledFields: [],
          skippedFields: [],
          blockers: [],
          message: "Vercel prepared the session. Run the local/IIS Chrome companion to autofill this application."
        },
        instructions: chromeSubmissionInstructions(refreshed.chromeProfileLabel)
      });
    }

    const submissionCompanionMatch = pathname.match(/^\/api\/submission-sessions\/([^/]+)\/companion-token$/);
    if (submissionCompanionMatch && method === "POST") {
      const data = state();
      const session = data.submissionSessions.find((item) => item.id === decodeURIComponent(submissionCompanionMatch[1]));
      if (!session) return sendJson(res, 404, { error: "Submission session not found" });
      const { companionToken, token } = createCompanionTokenPreview(data, session.id);
      return sendJson(res, 201, {
        companionToken: {
          id: companionToken.id,
          submissionSessionId: companionToken.submissionSessionId,
          expiresAt: companionToken.expiresAt
        },
        token
      });
    }

    const submissionConfirmMatch = pathname.match(/^\/api\/submission-sessions\/([^/]+)\/confirm-submitted$/);
    if (submissionConfirmMatch && method === "POST") {
      const data = state();
      const session = data.submissionSessions.find((item) => item.id === decodeURIComponent(submissionConfirmMatch[1]));
      if (!session) return sendJson(res, 404, { error: "Submission session not found" });
      if (session.status !== "waiting_for_manual_submit" && session.status !== "submitted") {
        return sendJson(res, 409, { error: "Start the Chrome session before recording manual submission proof." });
      }
      if (!isApproved(data.approvals, "portal_submit", session.applicationPlanId)) {
        return sendJson(res, 403, { error: "Application review approval is required before recording submission proof." });
      }
      const body = normalizeBody(req.body);
      const confirmationText = cleanText(body.confirmationText);
      if (!confirmationText) return sendJson(res, 400, { error: "Confirmation text or number is required." });
      const submittedAt = new Date().toISOString();
      session.status = "submitted";
      session.confirmationText = confirmationText;
      session.screenshotName = cleanText(body.screenshotName);
      session.screenshotPath = cleanText(body.screenshotPath);
      session.submittedAt = submittedAt;
      session.updatedAt = submittedAt;
      const scholarship = data.scholarships.find((item) => item.id === session.scholarshipId);
      if (scholarship) scholarship.status = "submitted";
      audit(data, "parent", "submission_confirmed", "submission_session", session.id, {
        applicationPlanId: session.applicationPlanId,
        scholarshipId: session.scholarshipId,
        studentId: session.studentId,
        confirmationText,
        screenshotName: session.screenshotName
      });
      return sendJson(res, 200, { submissionSession: session, dashboard: dashboard(data) });
    }

    if (pathname === "/api/export" && method === "GET") {
      return sendJson(res, 200, dashboard(state()));
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
}

function state() {
  if (globalThis.__scholarshipPortalState) {
    globalThis.__scholarshipPortalState.submissionSessions ??= [];
    globalThis.__scholarshipPortalState.portalInvites ??= [];
    globalThis.__scholarshipPortalState.agentRunLocks ??= [];
    globalThis.__scholarshipPortalState.familyMembers ??= [];
    globalThis.__scholarshipPortalState.betaInvites ??= [];
    globalThis.__scholarshipPortalState.companionTokens ??= [];
    globalThis.__scholarshipPortalState.portalUsers ??= [
      {
        ...globalThis.__scholarshipPortalState.user,
        password: process.env.PORTAL_ADMIN_PASSWORD ?? "change-me-now"
      }
    ];
    return globalThis.__scholarshipPortalState;
  }

  const now = new Date().toISOString();
  const profile = sampleStudentProfile();
  const student = {
    id: randomUUID(),
    familyId: FAMILY_ID,
    name: profile.preferredName,
    graduationYear: profile.graduationYear,
    schoolState: profile.schoolState,
    profile,
    createdAt: now
  };

  const user = {
    id: USER_ID,
    familyId: FAMILY_ID,
    email: process.env.PORTAL_ADMIN_EMAIL ?? "parent@example.com",
    displayName: "Parent",
    role: "parent",
    createdAt: now
  };

  globalThis.__scholarshipPortalState = {
    family: { id: FAMILY_ID, clerkOrgId: "org_vercel_preview", name: "My Family", status: "beta_active", createdAt: now, updatedAt: now },
    user,
    familyMembers: [
      {
        id: randomUUID(),
        familyId: FAMILY_ID,
        clerkUserId: USER_ID,
        email: user.email,
        role: "Admin",
        profileIds: [],
        status: "active",
        createdAt: now,
        updatedAt: now
      }
    ],
    betaInvites: [],
    agentRunLocks: [],
    companionTokens: [],
    portalUsers: [{ ...user, password: process.env.PORTAL_ADMIN_PASSWORD ?? "change-me-now" }],
    portalInvites: [],
    students: [student],
    scholarships: [],
    documents: [
      {
        id: randomUUID(),
        familyId: FAMILY_ID,
        studentId: student.id,
        type: "resume",
        name: "Student activities resume",
        path: "vercel-preview/resume-placeholder.pdf",
        status: "available",
        uploadedAt: now
      },
      {
        id: randomUUID(),
        familyId: FAMILY_ID,
        studentId: student.id,
        type: "transcript",
        name: "Unofficial transcript",
        path: "vercel-preview/transcript-placeholder.pdf",
        status: "needs_update",
        uploadedAt: now
      }
    ],
    essayDrafts: [],
    applicationPlans: [],
    submissionSessions: [],
    approvals: [],
    auditEvents: [],
    agentRuns: [],
    settings: defaultSettings(user.email)
  };
  audit(globalThis.__scholarshipPortalState, "system", "vercel_preview_seeded", "family", FAMILY_ID, {
    note: "Preview state is in-memory. Configure Postgres before production use."
  });
  return globalThis.__scholarshipPortalState;
}

function acquirePreviewRunLock(data, familyId, runType, ttlMs = 55 * 60 * 1000) {
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = data.agentRunLocks.find((item) => item.familyId === familyId && item.runType === runType);
  if (existing && existing.lockUntil > nowIso) return undefined;
  const lock = {
    familyId,
    runType,
    lockUntil: new Date(now.getTime() + ttlMs).toISOString(),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso
  };
  if (existing) Object.assign(existing, lock);
  else data.agentRunLocks.push(lock);
  return lock;
}

function releasePreviewRunLock(data, familyId, runType) {
  data.agentRunLocks = data.agentRunLocks.filter((item) => item.familyId !== familyId || item.runType !== runType);
}

function createCompanionTokenPreview(data, submissionSessionId, ttlMs = 15 * 60 * 1000) {
  const now = new Date();
  const token = randomUUID();
  const companionToken = {
    id: randomUUID(),
    familyId: FAMILY_ID,
    submissionSessionId,
    token,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    usedAt: undefined,
    createdAt: now.toISOString()
  };
  data.companionTokens.unshift(companionToken);
  audit(data, "agent", "companion_token_created", "submission_session", submissionSessionId, {
    expiresAt: companionToken.expiresAt
  });
  return { companionToken, token };
}

function consumeCompanionTokenPreview(data, token) {
  const now = new Date().toISOString();
  const companion = data.companionTokens.find((item) => item.token === token && !item.usedAt && item.expiresAt > now);
  if (!companion) return undefined;
  companion.usedAt = now;
  return companion;
}

function runWeeklyPipelinePreview(data) {
  const started = new Date().toISOString();
  const run = {
    id: randomUUID(),
    familyId: FAMILY_ID,
    runType: "weekly_pipeline",
    status: "running",
    summary: "Finding no-essay scholarships and preparing the review queue.",
    createdAt: started,
    output: {}
  };
  data.agentRuns.unshift(run);

  const student = data.students[0];
  const allDiscovered = dedupeScholarships(discoverScholarshipsFromPublicSources());
  const discovered = filterNoEssayScholarships(allDiscovered);
  const skippedEssayRequired = allDiscovered.length - discovered.length;
  for (const item of discovered) {
    let scholarship = data.scholarships.find((candidate) => candidate.url === item.url);
    const score = scoreScholarship(student, { ...item, risks: item.risks });
    if (!scholarship) {
      scholarship = {
        id: randomUUID(),
        familyId: FAMILY_ID,
        title: item.title,
        provider: item.provider,
        url: item.url,
        award: item.award,
        deadline: item.deadline,
        status: "matched",
        fitScore: score.fitScore,
        effort: score.effort,
        requirements: item.requirements,
        risks: score.risks,
        tags: item.tags,
        sourceQuote: item.sourceQuote,
        createdAt: started
      };
      data.scholarships.push(scholarship);
    } else {
      scholarship.fitScore = score.fitScore;
      scholarship.effort = score.effort;
      scholarship.status = score.fitScore >= 60 ? "matched" : "new";
      scholarship.risks = score.risks;
    }
    audit(data, "agent", "scholarship_scored", "scholarship", scholarship.id, {
      fitScore: score.fitScore,
      effort: score.effort
    });
  }

  const ranked = data.scholarships
    .filter((scholarship) => scholarship.fitScore >= 60 && !scholarshipRequiresEssay(scholarship))
    .sort((a, b) => b.fitScore - a.fitScore || a.deadline.localeCompare(b.deadline))
    .slice(0, TOP_REVIEW_MATCH_LIMIT);

  const activeReviewPlanIds = [];
  for (const scholarship of ranked) {
    scholarship.status = "ready_for_review";
    const plan = upsertPlan(data, {
      id: randomUUID(),
      familyId: FAMILY_ID,
      createdAt: new Date().toISOString(),
      ...prepareApplicationPlan(student, scholarship, data.documents)
    });
    activeReviewPlanIds.push(plan.id);
    createApprovalIfMissing(data, {
      actionType: "portal_submit",
      targetType: "application_plan",
      targetId: plan.id,
      summary: `Review ${scholarship.title} for ${student.profile.preferredName}. The app will not submit without this approval.`,
      riskLevel: riskForRequirements(scholarship.requirements)
    });
    if (plan.browserSteps.some((step) => step.action === "upload")) {
      createApprovalIfMissing(data, {
        actionType: "file_upload",
        targetType: "application_plan",
        targetId: plan.id,
        summary: `Approve document staging/upload for ${scholarship.title}.`,
        riskLevel: "medium"
      });
    }
    for (const actionType of approvalActionsForRequirements(scholarship.requirements)) {
      createApprovalIfMissing(data, {
        actionType,
        targetType: "application_plan",
        targetId: plan.id,
        summary: `Review ${actionType.replaceAll("_", " ")} language for ${scholarship.title}. Chrome prep will stop until approved.`,
        riskLevel: actionType === "signature" || actionType === "payment" ? "high" : "medium"
      });
    }
  }
  const supersededReviewItems = supersedeStaleApplicationReviewApprovalsPreview(data, activeReviewPlanIds);

  run.status = "completed";
  run.summary = `Prepared ${ranked.length} no-essay scholarship applications for review.`;
  run.completedAt = new Date().toISOString();
  run.output = { discovered: discovered.length, skippedEssayRequired, preparedForReview: ranked.length, supersededReviewItems, topReviewMatchLimit: TOP_REVIEW_MATCH_LIMIT };
  return run;
}

function dashboard(data) {
  return {
    family: data.family,
    user: publicUser(data.user),
    students: data.students,
    scholarships: [...data.scholarships].sort((a, b) => b.fitScore - a.fitScore || a.deadline.localeCompare(b.deadline)),
    documents: data.documents,
    essayDrafts: data.essayDrafts,
    applicationPlans: data.applicationPlans,
    submissionSessions: data.submissionSessions,
    approvals: data.approvals,
    auditEvents: data.auditEvents.slice(0, 80),
    agentRuns: data.agentRuns.slice(0, 25),
    settings: normalizeSettings(data.settings, defaultSettings(data.user.email), data.user.email),
    latestInvites: latestInviteSummariesPreview(data)
  };
}

function latestInviteSummariesPreview(data, limit = 5) {
  const now = new Date().toISOString();
  return [...(data.portalInvites ?? [])]
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, limit)
    .map((invite) => {
      const accepted = Boolean(invite.acceptedAt);
      const expired = !accepted && String(invite.expiresAt ?? "") <= now;
      const status = accepted
        ? "accepted"
        : expired
          ? "expired"
          : invite.deliveryStatus ?? "manual";
      return {
        id: invite.id,
        email: invite.email,
        status,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt || undefined,
        inviteUrl: accepted || expired ? undefined : invite.inviteUrl || previewInviteUrl(invite),
        providerMessageId: invite.providerMessageId || undefined,
        error: invite.deliveryError || undefined
      };
    });
}

function previewInviteUrl(invite) {
  if (!invite?.token) return undefined;
  const configured = process.env.PUBLIC_APP_URL?.trim();
  const base = configured
    ? configured.replace(/\/$/, "")
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://scholarship-agent-app.vercel.app";
  return `${base}/invite.html?invite=${encodeURIComponent(invite.token)}&email=${encodeURIComponent(invite.email ?? "")}`;
}

function studentFromProfile(profile, id = randomUUID()) {
  return {
    id,
    familyId: FAMILY_ID,
    name: profile.preferredName,
    graduationYear: profile.graduationYear,
    schoolState: profile.schoolState,
    profile,
    createdAt: new Date().toISOString()
  };
}

function normalizeStudentSync(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const id = cleanText(item?.id) || randomUUID();
      const profileInput = item?.profile && typeof item.profile === "object" ? item.profile : item;
      const profile = mergeStudentProfile(blankStudentProfile(), profileInput ?? {});
      if (!profile.preferredName || !profile.legalName || !profile.schoolState || !Number.isFinite(profile.graduationYear)) {
        return undefined;
      }
      return {
        ...studentFromProfile(profile, id),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString()
      };
    })
    .filter(Boolean);
}

function reconcileDocumentsForStudents(data) {
  const studentIds = new Set(data.students.map((student) => student.id));
  const matchingDocuments = data.documents.filter((document) => studentIds.has(document.studentId));
  if (matchingDocuments.length || !data.students.length) {
    data.documents = matchingDocuments;
    return;
  }
  const firstStudent = data.students[0];
  data.documents = data.documents.map((document) => ({
    ...document,
    id: randomUUID(),
    studentId: firstStudent.id,
    uploadedAt: new Date().toISOString()
  }));
}

function deleteStudentPreview(data, studentId) {
  const index = data.students.findIndex((student) => student.id === studentId);
  if (index < 0) return undefined;
  const [student] = data.students.splice(index, 1);
  const planIds = new Set(data.applicationPlans.filter((plan) => plan.studentId === studentId).map((plan) => plan.id));
  data.documents = data.documents.filter((document) => document.studentId !== studentId);
  data.essayDrafts = data.essayDrafts.filter((draft) => draft.studentId !== studentId);
  data.applicationPlans = data.applicationPlans.filter((plan) => plan.studentId !== studentId);
  data.submissionSessions = data.submissionSessions.filter((session) => session.studentId !== studentId && !planIds.has(session.applicationPlanId));
  data.approvals = data.approvals.filter((approval) => approval.targetType !== "application_plan" || !planIds.has(approval.targetId));
  return student;
}

function normalizeDocumentSync(input, data) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => normalizeDocumentRecord(item, data)).filter(Boolean);
}

function normalizeDocumentRecord(input, data) {
  const studentId = cleanText(input?.studentId);
  if (!data.students.some((student) => student.id === studentId)) return undefined;
  const type = ["resume", "transcript", "recommendation", "essay", "other"].includes(input?.type) ? input.type : "other";
  const name = cleanText(input?.name);
  if (!name) return undefined;
  const status = ["available", "missing", "needs_update"].includes(input?.status) ? input.status : "available";
  return {
    id: cleanText(input?.id) || randomUUID(),
    familyId: FAMILY_ID,
    studentId,
    type,
    name,
    path: cleanText(input?.path) || `browser-local://${type}/${name}`,
    status,
    uploadedAt: typeof input?.uploadedAt === "string" ? input.uploadedAt : new Date().toISOString()
  };
}

function upsertDocument(data, document) {
  const index = data.documents.findIndex((item) => item.id === document.id);
  if (index >= 0) data.documents[index] = document;
  else data.documents.unshift(document);
}

function deleteDocument(data, documentId) {
  const index = data.documents.findIndex((item) => item.id === documentId);
  if (index < 0) return undefined;
  const [document] = data.documents.splice(index, 1);
  return document;
}

function updateDocument(data, documentId, input) {
  const index = data.documents.findIndex((item) => item.id === documentId);
  if (index < 0) return undefined;
  const previous = data.documents[index];
  const studentId = cleanText(input?.studentId) || previous.studentId;
  if (!data.students.some((student) => student.id === studentId)) return undefined;
  const type = input?.type === undefined ? previous.type : ["resume", "transcript", "recommendation", "essay", "other"].includes(input.type) ? input.type : "other";
  const status = input?.status === undefined ? previous.status : ["available", "missing", "needs_update"].includes(input.status) ? input.status : "available";
  const name = cleanText(input?.name) || previous.name;
  const path = cleanText(input?.path) || previous.path;
  const document = { ...previous, studentId, type, status, name, path };
  data.documents[index] = document;
  return { previous, document };
}

function refreshPlansForDocumentStudent(data, studentId) {
  const student = data.students.find((item) => item.id === studentId);
  if (!student) return;
  for (const plan of data.applicationPlans.filter((item) => item.studentId === studentId)) {
    const scholarship = data.scholarships.find((item) => item.id === plan.scholarshipId);
    if (!scholarship) continue;
    const refreshed = prepareApplicationPlan(student, scholarship, data.documents);
    Object.assign(plan, {
      ...refreshed,
      id: plan.id,
      familyId: FAMILY_ID,
      createdAt: plan.createdAt
    });
  }
}

function blankStudentProfile() {
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

function defaultSettings(ownerEmail = "parent@example.com") {
  return {
    users: [
      {
        id: "owner",
        name: "Parent",
        email: ownerEmail,
        role: "Admin",
        status: "active",
        profileAccess: "all",
        profileIds: []
      }
    ],
    customBoxes: [],
    customFields: [],
    customTabs: [],
    roleRights: defaultRoleRights(),
    updatedAt: new Date().toISOString()
  };
}

function defaultRoleRights() {
  return {
    Admin: {
      manageSettings: true,
      manageUsers: true,
      manageProfiles: true,
      manageScholarships: true,
      prepareApplications: true,
      approveActions: true,
      viewAudit: true
    },
    Employee: {
      manageSettings: false,
      manageUsers: false,
      manageProfiles: true,
      manageScholarships: true,
      prepareApplications: true,
      approveActions: false,
      viewAudit: false
    },
    Guest: {
      manageSettings: false,
      manageUsers: false,
      manageProfiles: false,
      manageScholarships: false,
      prepareApplications: false,
      approveActions: false,
      viewAudit: false
    },
    Viewer: {
      manageSettings: false,
      manageUsers: false,
      manageProfiles: false,
      manageScholarships: false,
      prepareApplications: false,
      approveActions: false,
      viewAudit: true
    }
  };
}

function normalizeSettings(input, fallback = defaultSettings(), ownerEmail = "parent@example.com") {
  const source = input ?? {};
  return {
    users: normalizeUsers(source.users ?? fallback.users, ownerEmail),
    customBoxes: normalizeCustomBoxes(source.customBoxes ?? fallback.customBoxes),
    customFields: normalizeCustomFields(source.customFields ?? fallback.customFields),
    customTabs: normalizeCustomTabs(source.customTabs ?? fallback.customTabs),
    roleRights: normalizeRoleRights(source.roleRights ?? fallback.roleRights),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt ?? new Date().toISOString()
  };
}

function normalizeRoleRights(input) {
  const defaults = defaultRoleRights();
  const rights = structuredClone(defaults);
  for (const role of SETTINGS_ROLES) {
    const roleInput = input?.[role] ?? {};
    for (const capability of SETTINGS_CAPABILITIES) {
      rights[role][capability] =
        typeof roleInput[capability] === "boolean" ? roleInput[capability] : defaults[role][capability];
    }
    if (role !== "Admin") {
      rights[role].manageSettings = false;
      rights[role].manageUsers = false;
    }
  }
  rights.Admin.manageSettings = true;
  rights.Admin.manageUsers = true;
  return rights;
}

function normalizeUsers(input, ownerEmail) {
  const users = (Array.isArray(input) ? input : [])
    .map((user) => {
      const name = cleanText(user.name);
      const email = cleanText(user.email).toLowerCase();
      if (!name || !email) return undefined;
      const role = SETTINGS_ROLES.includes(user.role) ? user.role : "Viewer";
      return {
        id: cleanText(user.id) || randomUUID(),
        name,
        email,
        role,
        status: user.status === "inactive" ? "inactive" : "active",
        profileAccess: role === "Admin" ? "all" : "assigned",
        profileIds: role === "Admin" ? [] : normalizeProfileIds(user.profileIds)
      };
    })
    .filter(Boolean);

  if (!users.length) {
    users.push({
      id: "owner",
      name: "Parent",
      email: ownerEmail,
      role: "Admin",
      status: "active",
      profileAccess: "all",
      profileIds: []
    });
  }
  return dedupeBy(users, (user) => user.email);
}

function normalizeProfileIds(input) {
  return [
    ...new Set(
      (Array.isArray(input) ? input : [])
        .map((id) => cleanText(id))
        .filter(Boolean)
    )
  ];
}

function usersMissingProfileAssignments(settings, students) {
  const availableProfileIds = new Set(students.map((student) => student.id));
  return settings.users
    .filter((user) => {
      if (user.role === "Admin") return false;
      return !user.profileIds.some((id) => availableProfileIds.has(String(id)));
    })
    .map((user) => user.name || user.email || "Unnamed user");
}

function normalizeCustomBoxes(input) {
  return (Array.isArray(input) ? input : [])
    .map((box) => {
      const title = cleanText(box.title);
      if (!title) return undefined;
      return {
        id: cleanText(box.id) || randomUUID(),
        title,
        content: cleanText(box.content)
      };
    })
    .filter(Boolean);
}

function normalizeCustomFields(input) {
  const appliesToValues = ["student_profile", "scholarship", "application", "document", "approval"];
  const typeValues = ["text", "long_text", "number", "date", "yes_no"];
  return (Array.isArray(input) ? input : [])
    .map((field) => {
      const label = cleanText(field.label);
      if (!label) return undefined;
      return {
        id: cleanText(field.id) || randomUUID(),
        label,
        appliesTo: appliesToValues.includes(field.appliesTo) ? field.appliesTo : "student_profile",
        type: typeValues.includes(field.type) ? field.type : "text"
      };
    })
    .filter(Boolean);
}

function normalizeCustomTabs(input) {
  return (Array.isArray(input) ? input : [])
    .map((tab) => {
      const label = cleanText(tab.label);
      if (!label) return undefined;
      return {
        id: cleanText(tab.id) || randomUUID(),
        label,
        description: cleanText(tab.description)
      };
    })
    .filter(Boolean);
}

function dedupeBy(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeStudentProfile(base, input) {
  return {
    ...base,
    ...input,
    preferredName: cleanText(input.preferredName ?? base.preferredName),
    legalName: cleanText(input.legalName ?? base.legalName),
    firstName: cleanText(input.firstName ?? base.firstName),
    lastName: cleanText(input.lastName ?? base.lastName),
    email: cleanText(input.email ?? base.email).toLowerCase(),
    gender: cleanText(input.gender ?? base.gender),
    dateOfBirth: cleanText(input.dateOfBirth ?? base.dateOfBirth),
    graduationYear: Number(input.graduationYear ?? base.graduationYear),
    graduationMonth: cleanText(input.graduationMonth ?? base.graduationMonth),
    gradeLevel: ["freshman", "sophomore", "junior", "senior"].includes(input.gradeLevel) ? input.gradeLevel : base.gradeLevel,
    schoolState: cleanText(input.schoolState ?? base.schoolState).toUpperCase(),
    highSchoolName: cleanText(input.highSchoolName ?? base.highSchoolName),
    gpa: input.gpa === null ? undefined : optionalNumber(input.gpa ?? base.gpa),
    citizenship: ["us_citizen", "permanent_resident", "other", "unknown"].includes(input.citizenship)
      ? input.citizenship
      : base.citizenship,
    firstGeneration:
      input.firstGeneration === null
        ? undefined
        : typeof input.firstGeneration === "boolean"
          ? input.firstGeneration
          : base.firstGeneration,
    financialNeed: ["yes", "no", "unknown"].includes(input.financialNeed) ? input.financialNeed : base.financialNeed,
    intendedMajors: cleanList(input.intendedMajors ?? base.intendedMajors),
    collegesConsidering: cleanList(input.collegesConsidering ?? base.collegesConsidering),
    activities: cleanList(input.activities ?? base.activities),
    serviceHours: input.serviceHours === null ? undefined : optionalNumber(input.serviceHours ?? base.serviceHours),
    awards: cleanList(input.awards ?? base.awards),
    streetAddress: cleanText(input.streetAddress ?? base.streetAddress),
    city: cleanText(input.city ?? base.city),
    postalCode: cleanText(input.postalCode ?? base.postalCode),
    constraints: cleanList(input.constraints ?? base.constraints),
    essayInterview: {
      ...base.essayInterview,
      ...(input.essayInterview ?? {})
    }
  };
}

function discoverScholarshipsFromPublicSources() {
  return [
    {
      title: "Civic Futures Scholarship",
      provider: "Civic Futures Foundation",
      url: "https://example.org/scholarships/civic-futures",
      award: "$2,500",
      deadline: "2026-10-15",
      tags: ["service", "leadership", "essay"],
      sourceQuote:
        "Open to U.S. high school juniors and seniors with community service experience. Requires a 500-650 word essay and applicant attestation.",
      requirements: [
        { kind: "grade", label: "High school junior or senior", required: true, value: "junior_or_senior" },
        { kind: "citizenship", label: "U.S. citizen or permanent resident", required: true, value: "us_or_pr" },
        { kind: "service", label: "Community service experience", required: true },
        { kind: "essay", label: "500-650 word essay", required: true, value: 650 },
        { kind: "attestation", label: "Applicant certifies all information is accurate", required: true }
      ],
      risks: ["Requires attestation before submission."]
    },
    {
      title: "STEM Next Generation Award",
      provider: "Future Builders Alliance",
      url: "https://scholarships360.org/scholarships/search/10000-no-essay-scholarship/",
      award: "$5,000",
      deadline: "2026-11-01",
      tags: ["stem", "computer science", "recommendation"],
      sourceQuote:
        "For high school seniors or juniors planning a STEM major. Minimum 3.4 GPA. Requires transcript, activities resume, and one recommendation.",
      requirements: [
        { kind: "grade", label: "High school junior or senior", required: true, value: "junior_or_senior" },
        { kind: "gpa", label: "Minimum 3.4 GPA", required: true, value: 3.4 },
        { kind: "major", label: "Planning a STEM major", required: true, value: "stem" },
        { kind: "document", label: "Transcript", required: true, value: "transcript" },
        { kind: "document", label: "Activities resume", required: true, value: "resume" },
        { kind: "recommendation", label: "One recommendation", required: true }
      ],
      risks: ["Recommendation request needs explicit parent/student review."]
    },
    {
      title: "Texas Opportunity No-Essay Grant",
      provider: "Texas Opportunity Fund",
      url: "https://www.niche.com/colleges/scholarships/no-essay-scholarship/",
      award: "$1,500",
      deadline: "2026-09-10",
      tags: ["local", "no-essay", "quick apply"],
      sourceQuote:
        "Open to Texas high school juniors and seniors. No essay required. Applicant completes a profile, confirms residency, and uploads an activities list.",
      requirements: [
        { kind: "grade", label: "High school junior or senior", required: true, value: "junior_or_senior" },
        { kind: "location", label: "Texas resident or student", required: true, value: "TX" },
        { kind: "citizenship", label: "U.S. citizen or permanent resident", required: true, value: "us_or_pr" },
        { kind: "document", label: "Activities list", required: true, value: "resume" },
        { kind: "attestation", label: "Applicant confirms profile information is accurate", required: true }
      ],
      risks: ["Attestation language must be reviewed before submission."]
    },
    {
      title: "Merit Snapshot No-Essay Scholarship",
      provider: "Merit Snapshot Foundation",
      url: "https://www.appily.com/scholarships/easy-money-scholarship",
      award: "$2,000",
      deadline: "2026-10-01",
      tags: ["merit", "no-essay", "transcript"],
      sourceQuote: "No essay required. High school juniors and seniors may apply with GPA, transcript, and basic activity information.",
      requirements: [
        { kind: "grade", label: "High school junior or senior", required: true, value: "junior_or_senior" },
        { kind: "gpa", label: "Minimum 3.2 GPA", required: true, value: 3.2 },
        { kind: "citizenship", label: "U.S. citizen or permanent resident", required: true, value: "us_or_pr" },
        { kind: "document", label: "Transcript", required: true, value: "transcript" }
      ],
      risks: []
    },
    {
      title: "Community Service Quick Apply Award",
      provider: "Neighborhood Service Alliance",
      url: "https://bold.org/scholarships/the-be-bold-no-essay-scholarship/",
      award: "$1,000",
      deadline: "2026-11-18",
      tags: ["service", "no-essay", "quick apply"],
      sourceQuote: "No essay required. Applicants list service activities and upload a resume or activity sheet.",
      requirements: [
        { kind: "grade", label: "High school junior or senior", required: true, value: "junior_or_senior" },
        { kind: "service", label: "Community service experience", required: true },
        { kind: "citizenship", label: "U.S. citizen or permanent resident", required: true, value: "us_or_pr" },
        { kind: "document", label: "Activities resume", required: true, value: "resume" }
      ],
      risks: []
    },
    {
      title: "Local Leaders Foundation Grant",
      provider: "Local Leaders Foundation",
      url: "https://example.org/scholarships/local-leaders",
      award: "$1,000",
      deadline: "2026-09-20",
      tags: ["local", "leadership", "low effort"],
      sourceQuote: "Students in Texas may apply with a short leadership statement, activities list, and no application fee.",
      requirements: [
        { kind: "location", label: "Texas resident or student", required: true, value: "TX" },
        { kind: "essay", label: "Short leadership statement", required: true, value: 300 },
        { kind: "document", label: "Activities list", required: true, value: "resume" }
      ],
      risks: []
    },
    {
      title: "First-Gen Forward Scholarship",
      provider: "First-Gen Forward",
      url: "https://example.org/scholarships/first-gen-forward",
      award: "$3,000",
      deadline: "2026-12-05",
      tags: ["first-generation", "need", "essay"],
      sourceQuote:
        "For first-generation college-bound high school students. Financial need considered. Essay asks about goals and support systems.",
      requirements: [
        { kind: "grade", label: "High school junior or senior", required: true, value: "junior_or_senior" },
        { kind: "need", label: "Financial need considered", required: false },
        { kind: "essay", label: "Goals and support systems essay", required: true, value: 600 }
      ],
      risks: ["Financial need details should remain blank until parent review."]
    }
  ];
}

function scoreScholarship(student, scholarship) {
  const profile = student.profile;
  let score = 45;
  const risks = [...scholarship.risks];
  let effortPoints = 0;
  for (const requirement of scholarship.requirements) {
    if (requirement.kind === "grade") score += 12;
    if (requirement.kind === "gpa") score += typeof profile.gpa === "number" && profile.gpa >= Number(requirement.value) ? 12 : -20;
    if (requirement.kind === "citizenship") score += profile.citizenship === "us_citizen" ? 8 : -18;
    if (requirement.kind === "location") score += String(requirement.value).toUpperCase() === profile.schoolState.toUpperCase() ? 14 : -18;
    if (requirement.kind === "major") {
      const value = String(requirement.value ?? "").toLowerCase();
      const match = profile.intendedMajors.some((major) => {
        const normalized = major.toLowerCase();
        return normalized.includes(value) || (value === "stem" && /science|engineering|math|technology|computer/.test(normalized));
      });
      score += match ? 14 : -16;
    }
    if (requirement.kind === "service") score += 10;
    if (requirement.kind === "need" && profile.financialNeed === "unknown") risks.push("Financial need question requires parent review.");
    if (requirement.kind === "essay") {
      effortPoints += Number(requirement.value ?? 500) > 500 ? 2 : 1;
      score += 4;
    }
    if (requirement.kind === "document") effortPoints += 1;
    if (requirement.kind === "recommendation") {
      effortPoints += 3;
      risks.push("Recommendation request needs approval.");
    }
    if (requirement.kind === "attestation") {
      effortPoints += 1;
      risks.push("Attestation language must be reviewed before submission.");
    }
  }
  const effort = effortPoints <= 2 ? "low" : effortPoints <= 5 ? "medium" : "high";
  return { fitScore: Math.max(0, Math.min(100, score)), effort, risks: [...new Set(risks)] };
}

function draftEssayFromInterview(student, scholarship) {
  const interview = student.profile.essayInterview;
  const prompt = scholarship.tags.includes("service")
    ? "Describe how your service or leadership has affected your community."
    : scholarship.tags.includes("stem")
      ? "Describe your interest in STEM and how you hope to use it."
      : "Describe your goals, experiences, and why you are a strong applicant.";
  return {
    studentId: student.id,
    scholarshipId: scholarship.id,
    prompt,
    interview,
    draft: [
      `${student.profile.preferredName}'s story starts with practical leadership: noticing where a process is confusing and making it easier for other people to join in.`,
      `In robotics, ${student.profile.preferredName} ${interview.proudMoment.charAt(0).toLowerCase()}${interview.proudMoment.slice(1)}`,
      `${interview.communityImpact}`,
      `${interview.challenge}`,
      `Looking ahead, ${student.profile.preferredName} ${interview.futureGoal.charAt(0).toLowerCase()}${interview.futureGoal.slice(1)}`
    ].join("\n\n"),
    unsupportedClaims: [],
    status: "needs_student_review"
  };
}

function prepareApplicationPlan(student, scholarship, documents) {
  const requestedDocumentTypes = new Set();
  const missingFields = [];
  const documentRequests = [];
  if (!student.profile.email) missingFields.push("Student email is required for scholarship submission confirmations.");
  for (const requirement of scholarship.requirements) {
    if (requirement.kind === "need" && student.profile.financialNeed === "unknown") missingFields.push("Financial need details require parent review.");
    if (requirement.kind === "recommendation") {
      missingFields.push("Recommender name and email are required.");
      documentRequests.push("Recommendation letter or recommender request approval.");
    }
    if (requirement.kind === "attestation") missingFields.push("Applicant attestation must be reviewed by the student before submission.");
    if (requirement.kind === "document") {
      requestedDocumentTypes.add(String(requirement.value ?? "other"));
      const doc = documents.find((item) => item.studentId === student.id && item.type === String(requirement.value ?? "other"));
      if (!doc || doc.status !== "available") documentRequests.push(`${requirement.label} is ${doc?.status ?? "missing"}.`);
    }
  }
  const firstName = student.profile.firstName?.trim() || firstNameFromLegalName(student.profile.legalName || student.profile.preferredName);
  const lastName = student.profile.lastName?.trim() || lastNameFromLegalName(student.profile.legalName);
  const birthDate = dateParts(student.profile.dateOfBirth);
  const fieldMap = {
    student_name: student.profile.legalName,
    first_name: firstName,
    last_name: lastName,
    preferred_name: student.profile.preferredName,
    student_email: student.profile.email,
    confirmation_email: student.profile.email,
    gender: student.profile.gender || "",
    date_of_birth: student.profile.dateOfBirth || "",
    birth_month: birthDate.month,
    birth_day: birthDate.day,
    birth_year: birthDate.year,
    first_generation: typeof student.profile.firstGeneration === "boolean" ? (student.profile.firstGeneration ? "Yes" : "No") : "",
    graduation_month: student.profile.graduationMonth || "",
    graduation_year: String(student.profile.graduationYear),
    high_school_name: student.profile.highSchoolName || "",
    school_state: student.profile.schoolState,
    gpa: String(student.profile.gpa ?? ""),
    intended_majors: student.profile.intendedMajors.join(", "),
    colleges_considering: (student.profile.collegesConsidering ?? []).join(", "),
    activities_summary: student.profile.activities.join("; "),
    awards: student.profile.awards.join("; "),
    street_address: student.profile.streetAddress || "",
    city: student.profile.city || "",
    postal_code: student.profile.postalCode || ""
  };
  return {
    scholarshipId: scholarship.id,
    studentId: student.id,
    fieldMap,
    missingFields,
    documentRequests,
    browserSteps: [
      { action: "navigate", url: scholarship.url, note: "Open scholarship application page." },
      ...Object.entries(fieldMap).map(([selector, value]) => ({
        action: "fill",
        selector: `[name="${selector}"]`,
        value,
        source: "student_profile",
        label: fieldStepLabel(selector),
        aliases: fieldSelectorAliases(selector)
      })),
      ...documents
        .filter((doc) => doc.studentId === student.id && doc.status === "available" && requestedDocumentTypes.has(doc.type))
        .map((doc) => ({
          action: "upload",
          selector: `[data-document="${doc.type}"]`,
          documentId: doc.id,
          note: `Stage ${doc.name}; requires approval before upload.`
        })),
      {
        action: "stop_for_review",
        selector: `button[type="submit"], input[type="submit"]`,
        note: "Stop before any submit, signature, payment, recommendation request, or attestation action."
      }
    ],
    status: missingFields.length > 0 || documentRequests.length > 0 ? "prepared" : "ready_for_review"
  };
}

function firstNameFromLegalName(name) {
  return String(name || "").trim().split(/\s+/)[0] ?? "";
}

function lastNameFromLegalName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

function dateParts(rawDate) {
  const match = String(rawDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { month: "", day: "", year: "" };
  const month = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ][Number(match[2]) - 1] ?? "";
  return { month, day: String(Number(match[3])), year: match[1] };
}

function fieldSelectorAliases(field) {
  const aliases = {
    student_name: ["studentName", "applicantName", "legalName", "fullName", "name"],
    first_name: ["firstName", "applicantFirstName", "studentFirstName", "givenName"],
    last_name: ["lastName", "applicantLastName", "studentLastName", "familyName", "surname"],
    preferred_name: ["preferredName"],
    student_email: ["studentEmail", "applicantEmail", "email", "emailAddress"],
    confirmation_email: ["confirmEmail", "confirmationEmail", "emailConfirmation"],
    gender: ["gender"],
    date_of_birth: ["dateOfBirth", "dob", "birthDate"],
    birth_month: ["birthMonth", "dobMonth", "dateOfBirthMonth"],
    birth_day: ["birthDay", "dobDay", "dateOfBirthDay"],
    birth_year: ["birthYear", "dobYear", "dateOfBirthYear"],
    first_generation: ["firstGeneration", "firstGenerationCollegeStudent", "firstGen"],
    graduation_month: ["graduationMonth", "gradMonth", "highSchoolGraduationMonth"],
    graduation_year: ["graduationYear", "gradYear", "classYear", "highSchoolGraduationYear"],
    high_school_name: ["highSchoolName", "highSchool", "schoolName", "hsName"],
    school_state: ["schoolState", "state", "residentState", "homeState"],
    gpa: ["gradePointAverage", "unweightedGpa", "unweightedGPA"],
    intended_majors: ["intendedMajor", "major", "majors", "fieldOfStudy", "plannedMajor"],
    colleges_considering: ["collegeSearch", "collegesConsidering", "collegeList", "college"],
    activities_summary: ["activitiesSummary", "activities", "extracurriculars", "extracurricularActivities"],
    awards: ["honors", "awardsHonors", "achievements"],
    street_address: ["streetAddress", "address", "address1", "addressLine1"],
    city: ["city"],
    postal_code: ["zip", "zipCode", "postalCode"]
  };
  return (aliases[field] ?? []).flatMap((name) => [`[name="${name}"]`, `#${name}`]);
}

function fieldStepLabel(field) {
  const labels = {
    student_name: "Full name",
    first_name: "First name",
    last_name: "Last name",
    preferred_name: "Preferred name",
    student_email: "Student email",
    confirmation_email: "Confirmation email",
    gender: "Gender",
    date_of_birth: "Date of birth",
    birth_month: "Birth month",
    birth_day: "Birth day",
    birth_year: "Birth year",
    first_generation: "First-generation college student",
    graduation_month: "Graduation month",
    graduation_year: "Graduation year",
    high_school_name: "High school",
    school_state: "School state",
    gpa: "GPA",
    intended_majors: "Intended major",
    colleges_considering: "College search",
    activities_summary: "Activities",
    awards: "Awards",
    street_address: "Street address",
    city: "City",
    postal_code: "ZIP code"
  };
  return labels[field] ?? field;
}

function createAssistedBrowserSession(plan) {
  const safeSteps = plan.browserSteps.filter((step) => step.action !== "stop_for_review");
  const reviewStop = plan.browserSteps.find((step) => step.action === "stop_for_review");
  return {
    safeMode: true,
    applicationPlanId: plan.id,
    steps: safeSteps,
    blockedActions: ["click submit", "sign attestation", "send email", "request recommendation", "pay fee", "upload without approval"],
    reviewStop
  };
}

function refreshSubmissionSessionPreview(data, planId) {
  const plan = data.applicationPlans.find((item) => item.id === planId);
  if (!plan) return undefined;
  const existing = data.submissionSessions.find((item) => item.applicationPlanId === plan.id);
  if (existing?.status === "submitted") return existing;
  const scholarship = data.scholarships.find((item) => item.id === plan.scholarshipId);
  const assisted = createAssistedBrowserSession(plan);
  const blockers = detectSubmissionBlockers(plan, data.approvals, scholarship);
  const uploadApproved = isApproved(data.approvals, "file_upload", plan.id);
  const navigateStep = plan.browserSteps.find((step) => step.action === "navigate");
  const now = new Date().toISOString();
  const session = {
    id: existing?.id ?? randomUUID(),
    familyId: FAMILY_ID,
    applicationPlanId: plan.id,
    scholarshipId: plan.scholarshipId,
    studentId: plan.studentId,
    status: blockers.length ? "blocked" : "created",
    chromeProfile: "scholarship",
    chromeProfileLabel: "Scholarship Applications",
    launchUrl: navigateStep?.url ?? "",
    safeMode: true,
    steps: assisted.steps.filter((step) => step.action !== "upload" || uploadApproved),
    blockedActions: assisted.blockedActions,
    blockers,
    reviewStop: assisted.reviewStop,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  if (existing) Object.assign(existing, session);
  else data.submissionSessions.unshift(session);
  return existing ?? session;
}

function detectSubmissionBlockers(plan, approvals, scholarship) {
  const blockers = [];
  if (!isApproved(approvals, "portal_submit", plan.id)) {
    blockers.push("Approve the application review before starting Chrome-guided submission prep.");
  }
  if (plan.browserSteps.some((step) => step.action === "upload") && !isApproved(approvals, "file_upload", plan.id)) {
    blockers.push("Approve file upload/staging before any document is staged in Chrome.");
  }
  for (const requirement of scholarship?.requirements ?? []) {
    const actionType = requirementApprovalAction(requirement.kind);
    if (actionType && !isApproved(approvals, actionType, plan.id)) {
      blockers.push(`${requirement.label} requires ${actionType.replaceAll("_", " ")} approval before Chrome prep can continue.`);
    }
  }
  return [...new Set(blockers)];
}

function isApproved(approvals, actionType, planId) {
  return approvals.some(
    (approval) =>
      approval.actionType === actionType &&
      approval.targetType === "application_plan" &&
      approval.targetId === planId &&
      approval.status === "approved"
  );
}

function requirementApprovalAction(kind) {
  if (kind === "recommendation") return "recommendation_request";
  if (kind === "signature") return "signature";
  if (kind === "payment") return "payment";
  return "";
}

function safeCompanionStudent(student) {
  if (!student) return undefined;
  return {
    id: student.id,
    preferredName: student.profile.preferredName,
    graduationYear: student.profile.graduationYear,
    schoolState: student.profile.schoolState
  };
}

function safeCompanionScholarship(scholarship) {
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

function safeCompanionDocuments(documents) {
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

function chromeSubmissionInstructions(chromeProfileLabel) {
  return [
    `Use the dedicated ${chromeProfileLabel} Chrome profile for portal logins.`,
    "Log in manually if the scholarship portal asks.",
    "Only fill known profile fields and stage documents with approved upload permissions.",
    "Stop at the final review or submit screen. The app never clicks final submit."
  ];
}

function riskForRequirements(requirements) {
  if (requirements.some((requirement) => requirement.kind === "signature" || requirement.kind === "payment")) return "high";
  if (requirements.some((requirement) => requirement.kind === "attestation" || requirement.kind === "recommendation")) return "medium";
  return "low";
}

function approvalActionsForRequirements(requirements) {
  return [...new Set((requirements ?? []).map((requirement) => requirementApprovalAction(requirement.kind)).filter(Boolean))];
}

function dedupeScholarships(scholarships) {
  const seen = new Set();
  return scholarships.filter((scholarship) => {
    const key = scholarship.url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scholarshipRequiresEssay(scholarship) {
  return scholarship.requirements.some((requirement) => requirement.kind === "essay");
}

function filterNoEssayScholarships(scholarships) {
  return scholarships.filter((scholarship) => !scholarshipRequiresEssay(scholarship));
}

function upsertEssay(data, draft) {
  const index = data.essayDrafts.findIndex((item) => item.studentId === draft.studentId && item.scholarshipId === draft.scholarshipId);
  if (index >= 0) data.essayDrafts[index] = { ...data.essayDrafts[index], ...draft, id: data.essayDrafts[index].id };
  else data.essayDrafts.unshift(draft);
}

function upsertPlan(data, plan) {
  const index = data.applicationPlans.findIndex((item) => item.studentId === plan.studentId && item.scholarshipId === plan.scholarshipId);
  if (index >= 0) {
    data.applicationPlans[index] = { ...data.applicationPlans[index], ...plan, id: data.applicationPlans[index].id };
    return data.applicationPlans[index];
  }
  data.applicationPlans.unshift(plan);
  return plan;
}

function createApprovalIfMissing(data, input) {
  const existing = data.approvals.find(
    (approval) =>
      approval.actionType === input.actionType &&
      approval.targetType === input.targetType &&
      approval.targetId === input.targetId &&
      approval.status === "pending"
  );
  if (existing) return;
  data.approvals.unshift({
    id: randomUUID(),
    familyId: FAMILY_ID,
    status: "pending",
    requestedAt: new Date().toISOString(),
    ...input
  });
}

function supersedeStaleApplicationReviewApprovalsPreview(data, activePlanIds) {
  const active = new Set(activePlanIds.filter(Boolean));
  const now = new Date().toISOString();
  let count = 0;
  for (const approval of data.approvals) {
    if (
      approval.actionType === "portal_submit" &&
      approval.targetType === "application_plan" &&
      approval.status === "pending" &&
      !active.has(approval.targetId)
    ) {
      approval.status = "superseded";
      approval.decidedAt = now;
      approval.decisionNote = "Replaced by a newer no-essay search.";
      count += 1;
    }
  }
  if (count) {
    audit(data, "agent", "application_review_queue_superseded", "approval", FAMILY_ID, {
      count,
      activePlanIds: [...active]
    });
  }
  return count;
}

function audit(data, actor, eventType, targetType, targetId, detail) {
  data.auditEvents.unshift({
    id: randomUUID(),
    familyId: FAMILY_ID,
    actor,
    eventType,
    targetType,
    targetId,
    detail,
    createdAt: new Date().toISOString()
  });
}

function sampleStudentProfile() {
  return {
    preferredName: "Alex",
    legalName: "Alex Rivera",
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex.rivera@example.com",
    gender: "",
    dateOfBirth: "",
    graduationYear: 2027,
    graduationMonth: "June",
    gradeLevel: "junior",
    schoolState: "TX",
    highSchoolName: "",
    gpa: 3.7,
    citizenship: "us_citizen",
    firstGeneration: true,
    financialNeed: "unknown",
    intendedMajors: ["computer science", "public policy"],
    collegesConsidering: [],
    activities: ["robotics team", "student council", "food bank volunteering"],
    serviceHours: 120,
    awards: ["regional robotics design finalist"],
    streetAddress: "",
    city: "",
    postalCode: "",
    constraints: ["prefer no application fee", "needs parent review before sharing financial details"],
    essayInterview: {
      proudMoment:
        "I helped redesign our robotics team's intake process so new members without coding experience could contribute in the first month.",
      communityImpact:
        "At the food bank, I built a simple spreadsheet tracker that helped volunteers sort pantry requests faster during weekend shifts.",
      challenge: "I used to avoid speaking in meetings, then practiced leading short standups for robotics until presenting felt normal.",
      futureGoal:
        "I want to study technology and policy so I can build public tools that are practical for families who do not have time to decode complex systems.",
      voiceNotes: "Direct, warm, specific, not overly polished."
    }
  };
}

async function inviteNewSettingsUsersPreview(data, previousSettings, nextSettings, req) {
  const existingEmails = new Set((previousSettings.users ?? []).map((user) => user.email.toLowerCase()));
  const invites = [];
  for (const user of nextSettings.users ?? []) {
    if (existingEmails.has(user.email.toLowerCase()) || user.status !== "active") continue;
    invites.push(await sendSettingsUserInvitePreview(data, user, req));
  }
  return invites;
}

async function sendSettingsUserInvitePreview(data, user, req) {
  const token = `${randomUUID()}-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * Number(process.env.PORTAL_INVITE_TTL_DAYS ?? 7)).toISOString();
  const invite = {
    id: randomUUID(),
    familyId: FAMILY_ID,
    email: user.email.toLowerCase(),
    displayName: user.name,
    settingsRole: user.role,
    token,
    expiresAt,
    acceptedAt: "",
    deliveryStatus: "manual",
    deliveryError: "",
    providerMessageId: "",
    inviteUrl: "",
    createdAt: new Date().toISOString()
  };
  data.portalInvites.unshift(invite);
  const inviteUrl = `${portalBaseUrl(req)}/invite.html?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const result = await sendPortalInviteEmailPreview({
    email: user.email,
    displayName: user.name,
    role: user.role,
    familyName: data.family.name,
    inviteUrl
  });
  invite.deliveryStatus = result.status;
  invite.deliveryError = result.error ?? "";
  invite.providerMessageId = result.providerMessageId ?? "";
  invite.inviteUrl = inviteUrl;
  audit(data, "parent", `portal_invite_email_${result.status}`, "user", user.id, {
    email: user.email,
    status: result.status,
    providerMessageId: result.providerMessageId ?? "",
    error: result.error ?? ""
  });
  return result;
}

async function sendPortalInviteEmailPreview(input) {
  if (process.env.INVITE_DELIVERY_MODE?.trim().toLowerCase() === "manual") {
    return {
      email: input.email,
      status: "manual",
      inviteUrl: input.inviteUrl
    };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      email: input.email,
      status: "not_configured",
      inviteUrl: input.inviteUrl,
      error: "RESEND_API_KEY is not configured."
    };
  }
  const from = process.env.INVITE_EMAIL_FROM ?? "Scholarship Agent <onboarding@resend.dev>";
  const subject = `You're invited to ${input.familyName}'s Scholarship Agent portal`;
  const text = [
    `Hi ${input.displayName},`,
    "",
    `You've been invited as ${roleLabel(input.role)} to ${input.familyName}'s Scholarship Agent portal.`,
    "Use this secure link to set your password and sign in:",
    input.inviteUrl,
    "",
    "If you were not expecting this invite, you can ignore this email."
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #172026;">
      <h1 style="font-size: 22px;">Scholarship Agent invite</h1>
      <p>Hi ${escapeHtml(input.displayName)},</p>
      <p>You've been invited as <strong>${escapeHtml(roleLabel(input.role))}</strong> to ${escapeHtml(input.familyName)}'s Scholarship Agent portal.</p>
      <p><a href="${escapeHtml(input.inviteUrl)}" style="display: inline-block; background: #1e6f6b; color: white; padding: 10px 14px; border-radius: 8px; text-decoration: none; font-weight: 700;">Accept invite</a></p>
      <p style="font-size: 13px; color: #60707a;">If the button does not work, paste this link into your browser:<br />${escapeHtml(input.inviteUrl)}</p>
      <p style="font-size: 13px; color: #60707a;">If you were not expecting this invite, you can ignore this email.</p>
    </div>
  `;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `portal-invite-${input.email.toLowerCase()}`
      },
      body: JSON.stringify({ from, to: input.email, subject, text, html })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String(payload?.message ?? payload?.error ?? `Email provider returned ${response.status}.`);
      console.error("[portal-invite-email] Resend send failed", {
        status: response.status,
        recipient: input.email,
        from,
        message
      });
      return {
        email: input.email,
        status: "failed",
        inviteUrl: input.inviteUrl,
        error: message
      };
    }
    return {
      email: input.email,
      status: "sent",
      inviteUrl: input.inviteUrl,
      providerMessageId: typeof payload?.id === "string" ? payload.id : undefined
    };
  } catch (error) {
    return {
      email: input.email,
      status: "failed",
      inviteUrl: input.inviteUrl,
      error: error instanceof Error ? error.message : "Email send failed."
    };
  }
}

function acceptPortalInvitePreview(data, token, password) {
  if (!token) return { ok: false, error: "Invite link is missing." };
  if (password.length < 10) return { ok: false, error: "Password must be at least 10 characters." };
  const invite = data.portalInvites.find((item) => item.token === token && !item.acceptedAt && item.expiresAt > new Date().toISOString());
  if (!invite) return { ok: false, error: "Invite link is invalid or expired." };
  let user = data.portalUsers.find((item) => item.email.toLowerCase() === invite.email.toLowerCase());
  if (!user) {
    user = {
      id: randomUUID(),
      familyId: FAMILY_ID,
      email: invite.email,
      displayName: invite.displayName,
      role: "parent",
      password,
      createdAt: new Date().toISOString()
    };
    data.portalUsers.push(user);
  } else {
    user.displayName = invite.displayName;
    user.password = password;
  }
  invite.acceptedAt = new Date().toISOString();
  data.user = user;
  audit(data, "parent", "portal_invite_accepted", "user", user.id, {
    email: invite.email,
    settingsRole: invite.settingsRole
  });
  return { ok: true, user };
}

function isValidLogin(email, password) {
  const data = state();
  const invitedUser = data.portalUsers?.find((user) => user.email.toLowerCase() === email.toLowerCase() && user.password === password);
  if (invitedUser) {
    data.user = invitedUser;
    return true;
  }
  const expectedEmail = process.env.PORTAL_ADMIN_EMAIL ?? "parent@example.com";
  const expectedPassword = process.env.PORTAL_ADMIN_PASSWORD ?? "change-me-now";
  if (email.toLowerCase() === expectedEmail.toLowerCase() && password === expectedPassword) {
    data.user = data.portalUsers.find((user) => user.email.toLowerCase() === expectedEmail.toLowerCase()) ?? data.user;
    return true;
  }
  return false;
}

function portalBaseUrl(req) {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const proto = header(req, "x-forwarded-proto") || "https";
  const host = header(req, "host") || "scholarship-agent-app.vercel.app";
  return `${proto}://${host}`;
}

function roleLabel(role) {
  return role === "Employee" ? "Contributor" : role;
}

function hasSession(req) {
  return cookie(req).includes(`${SESSION_COOKIE}=${SESSION_VALUE}`);
}

function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET ?? "local-cron-secret";
  const authorization = header(req, "authorization");
  return authorization === `Bearer ${secret}` || header(req, "x-cron-secret") === secret;
}

function getBearerToken(req) {
  const authorization = header(req, "authorization");
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role
  };
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function cleanList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return String(value ?? "")
    .split(/\n|,/)
    .map(cleanText)
    .filter(Boolean);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=1209600`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
}

function cookie(req) {
  return header(req, "cookie");
}

function header(req, name) {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}
