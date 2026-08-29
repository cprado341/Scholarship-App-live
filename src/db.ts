import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./auth.ts";
import { sampleStudentProfile } from "./sampleData.ts";
import { decryptJson, encryptJson, loadOrCreateLocalKey } from "./security.ts";
import type {
  AgentRun,
  AgentRunLock,
  ApplicationPlan,
  Approval,
  ApprovalStatus,
  AuditEvent,
  BetaInvite,
  BrowserStep,
  CompanionToken,
  DashboardData,
  DiscoveredScholarship,
  DocumentRecord,
  EssayDraft,
  EssayInterview,
  Family,
  FamilyMember,
  FamilyStatus,
  InviteEmailResult,
  InviteSummary,
  PortalInvite,
  PortalSession,
  PortalUser,
  SaaSRole,
  SettingsCapability,
  SettingsData,
  SettingsRole,
  Scholarship,
  ScholarshipRequirement,
  ScholarshipStatus,
  SubmissionSession,
  SubmissionSessionStatus,
  Student,
  StudentProfile
} from "./types.ts";

export { sampleStudentProfile } from "./sampleData.ts";

type Row = Record<string, unknown>;
const DEFAULT_FAMILY_ID = "family_local";
const DEFAULT_EMAIL = process.env.PORTAL_ADMIN_EMAIL ?? "parent@example.com";
const DEFAULT_PASSWORD = process.env.PORTAL_ADMIN_PASSWORD ?? "change-me-now";
const SETTINGS_ROLES: SettingsRole[] = ["Admin", "Employee", "Guest", "Viewer"];
const SETTINGS_CAPABILITIES: SettingsCapability[] = [
  "manageSettings",
  "manageUsers",
  "manageProfiles",
  "manageScholarships",
  "prepareApplications",
  "approveActions",
  "viewAudit"
];
const SAAS_ROLES: SaaSRole[] = ["Admin", "Contributor", "Guest", "Viewer"];

function normalizeSaaSRole(role: SaaSRole): SaaSRole {
  return SAAS_ROLES.includes(role) ? role : "Viewer";
}

function mergeStudentProfile(base: StudentProfile, input: Partial<StudentProfile>): StudentProfile {
  return {
    preferredName: input.preferredName ?? base.preferredName,
    legalName: input.legalName ?? base.legalName,
    firstName: cleanText(input.firstName ?? base.firstName),
    lastName: cleanText(input.lastName ?? base.lastName),
    email: cleanText(input.email ?? base.email).toLowerCase(),
    gender: cleanText(input.gender ?? base.gender),
    dateOfBirth: cleanText(input.dateOfBirth ?? base.dateOfBirth),
    graduationYear: input.graduationYear ?? base.graduationYear,
    graduationMonth: cleanText(input.graduationMonth ?? base.graduationMonth),
    gradeLevel: input.gradeLevel ?? base.gradeLevel,
    schoolState: input.schoolState ?? base.schoolState,
    highSchoolName: cleanText(input.highSchoolName ?? base.highSchoolName),
    gpa: input.gpa === null ? undefined : input.gpa ?? base.gpa,
    citizenship: input.citizenship ?? base.citizenship,
    firstGeneration: input.firstGeneration === null ? undefined : input.firstGeneration ?? base.firstGeneration,
    financialNeed: input.financialNeed ?? base.financialNeed,
    intendedMajors: input.intendedMajors ?? base.intendedMajors,
    collegesConsidering: input.collegesConsidering ?? base.collegesConsidering ?? [],
    activities: input.activities ?? base.activities,
    serviceHours: input.serviceHours === null ? undefined : input.serviceHours ?? base.serviceHours,
    awards: input.awards ?? base.awards,
    streetAddress: cleanText(input.streetAddress ?? base.streetAddress),
    city: cleanText(input.city ?? base.city),
    postalCode: cleanText(input.postalCode ?? base.postalCode),
    constraints: input.constraints ?? base.constraints,
    essayInterview: {
      ...base.essayInterview,
      ...(input.essayInterview ?? {})
    }
  };
}

export function createDefaultSettings(ownerEmail = DEFAULT_EMAIL): SettingsData {
  const now = new Date().toISOString();
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
    updatedAt: now
  };
}

function defaultRoleRights(): SettingsData["roleRights"] {
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

function normalizeSettings(
  input: Partial<SettingsData> | undefined,
  ownerEmail = DEFAULT_EMAIL,
  fallback = createDefaultSettings(ownerEmail)
): SettingsData {
  const now = new Date().toISOString();
  const source = input ?? {};
  const roleRights = normalizeRoleRights(source.roleRights ?? fallback.roleRights);
  const users = normalizeUsers(source.users ?? fallback.users, ownerEmail);

  return {
    users,
    customBoxes: normalizeCustomBoxes(source.customBoxes ?? fallback.customBoxes),
    customFields: normalizeCustomFields(source.customFields ?? fallback.customFields),
    customTabs: normalizeCustomTabs(source.customTabs ?? fallback.customTabs),
    roleRights,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt ?? now
  };
}

function normalizeRoleRights(input: Partial<SettingsData["roleRights"]>): SettingsData["roleRights"] {
  const defaults = defaultRoleRights();
  const rights = structuredClone(defaults);
  for (const role of SETTINGS_ROLES) {
    const roleInput = input?.[role] ?? {};
    for (const capability of SETTINGS_CAPABILITIES) {
      rights[role][capability] = Boolean(roleInput[capability] ?? defaults[role][capability]);
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

function normalizeUsers(input: unknown, ownerEmail: string): SettingsData["users"] {
  const source = Array.isArray(input) ? input : [];
  const users = source
    .map((item) => {
      const user = item as Partial<SettingsData["users"][number]>;
      const email = cleanText(user.email).toLowerCase();
      const name = cleanText(user.name);
      if (!email || !name) return undefined;
      const role = SETTINGS_ROLES.includes(user.role as SettingsRole) ? user.role as SettingsRole : "Viewer";
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
    .filter((user): user is SettingsData["users"][number] => Boolean(user));

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

function normalizeProfileIds(input: unknown): string[] {
  const source = Array.isArray(input) ? input : [];
  return [...new Set(source.map((id) => cleanText(id)).filter(Boolean))];
}

function normalizeCustomBoxes(input: unknown): SettingsData["customBoxes"] {
  const source = Array.isArray(input) ? input : [];
  return source
    .map((item) => {
      const box = item as Partial<SettingsData["customBoxes"][number]>;
      const title = cleanText(box.title);
      if (!title) return undefined;
      return {
        id: cleanText(box.id) || randomUUID(),
        title,
        content: cleanText(box.content)
      };
    })
    .filter((box): box is SettingsData["customBoxes"][number] => Boolean(box));
}

function normalizeCustomFields(input: unknown): SettingsData["customFields"] {
  const source = Array.isArray(input) ? input : [];
  const appliesToValues = ["student_profile", "scholarship", "application", "document", "approval"];
  const typeValues = ["text", "long_text", "number", "date", "yes_no"];
  return source
    .map((item) => {
      const field = item as Partial<SettingsData["customFields"][number]>;
      const label = cleanText(field.label);
      if (!label) return undefined;
      return {
        id: cleanText(field.id) || randomUUID(),
        label,
        appliesTo: appliesToValues.includes(String(field.appliesTo)) ? field.appliesTo! : "student_profile",
        type: typeValues.includes(String(field.type)) ? field.type! : "text"
      };
    })
    .filter((field): field is SettingsData["customFields"][number] => Boolean(field));
}

function normalizeCustomTabs(input: unknown): SettingsData["customTabs"] {
  const source = Array.isArray(input) ? input : [];
  return source
    .map((item) => {
      const tab = item as Partial<SettingsData["customTabs"][number]>;
      const label = cleanText(tab.label);
      if (!label) return undefined;
      return {
        id: cleanText(tab.id) || randomUUID(),
        label,
        description: cleanText(tab.description)
      };
    })
    .filter((tab): tab is SettingsData["customTabs"][number] => Boolean(tab));
}

function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

export class AppRepository {
  readonly db: DatabaseSync;
  readonly key: Buffer;
  readonly baseDir: string;

  constructor(options: { dbPath?: string; baseDir?: string; key?: Buffer } = {}) {
    this.baseDir = options.baseDir ?? process.cwd();
    const dbPath = options.dbPath ?? path.join(this.baseDir, "data", "app.sqlite");
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.key = options.key ?? loadOrCreateLocalKey(this.baseDir);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.ensurePortalSeed();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        name TEXT NOT NULL,
        graduation_year INTEGER NOT NULL,
        school_state TEXT NOT NULL,
        profile_cipher TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scholarships (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        url TEXT NOT NULL,
        award TEXT NOT NULL,
        deadline TEXT NOT NULL,
        status TEXT NOT NULL,
        fit_score INTEGER NOT NULL,
        effort TEXT NOT NULL,
        requirements_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_quote TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(family_id, url)
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        student_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        blob_path TEXT,
        content_type TEXT,
        size_bytes INTEGER,
        status TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS essay_drafts (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        student_id TEXT NOT NULL,
        scholarship_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        interview_json TEXT NOT NULL,
        draft TEXT NOT NULL,
        unsupported_claims_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(student_id, scholarship_id),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(scholarship_id) REFERENCES scholarships(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS application_plans (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        scholarship_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        field_map_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        document_requests_json TEXT NOT NULL,
        browser_steps_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(student_id, scholarship_id),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(scholarship_id) REFERENCES scholarships(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        action_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decision_note TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        output_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS families (
        id TEXT PRIMARY KEY,
        clerk_org_id TEXT UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'beta_active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS family_members (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        clerk_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        profile_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(family_id, clerk_user_id),
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS beta_invites (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        clerk_invitation_id TEXT,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        family_id TEXT PRIMARY KEY,
        settings_cipher TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portal_users (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portal_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES portal_users(id) ON DELETE CASCADE,
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portal_invites (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        settings_role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        delivery_status TEXT,
        delivery_error TEXT,
        provider_message_id TEXT,
        invite_url_cipher TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS submission_sessions (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        application_plan_id TEXT NOT NULL,
        scholarship_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        status TEXT NOT NULL,
        chrome_profile TEXT NOT NULL,
        chrome_profile_label TEXT NOT NULL,
        launch_url TEXT NOT NULL,
        safe_mode INTEGER NOT NULL,
        steps_json TEXT NOT NULL,
        blocked_actions_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        review_stop_json TEXT NOT NULL,
        confirmation_text TEXT,
        screenshot_name TEXT,
        screenshot_path TEXT,
        submitted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(family_id, application_plan_id),
        FOREIGN KEY(application_plan_id) REFERENCES application_plans(id) ON DELETE CASCADE,
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(scholarship_id) REFERENCES scholarships(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_run_locks (
        family_id TEXT NOT NULL,
        run_type TEXT NOT NULL,
        lock_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(family_id, run_type),
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS companion_tokens (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        submission_session_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(family_id) REFERENCES families(id) ON DELETE CASCADE,
        FOREIGN KEY(submission_session_id) REFERENCES submission_sessions(id) ON DELETE CASCADE
      );
    `);
    this.backfillPortalColumns();
    this.backfillSaaSColumns();
    this.normalizeScholarshipUniqueness();
  }

  dashboard(familyId = DEFAULT_FAMILY_ID, user?: PortalUser): DashboardData {
    return {
      family: this.getFamily(familyId) ?? this.getFamily(DEFAULT_FAMILY_ID)!,
      user: user
        ? { id: user.id, email: user.email, displayName: user.displayName, role: user.role }
        : undefined,
      students: this.listStudents(familyId),
      scholarships: this.listScholarships(familyId),
      documents: this.listDocuments(familyId),
      essayDrafts: this.listEssayDrafts(familyId),
      applicationPlans: this.listApplicationPlans(familyId),
      submissionSessions: this.listSubmissionSessions(familyId),
      approvals: this.listApprovals(familyId),
      auditEvents: this.listAuditEvents(familyId),
      agentRuns: this.listAgentRuns(familyId),
      settings: this.getSettings(familyId),
      latestInvites: this.listPortalInviteSummaries(familyId)
    };
  }

  getSettings(familyId = DEFAULT_FAMILY_ID): SettingsData {
    const row = this.db.prepare("SELECT * FROM app_settings WHERE family_id = ?").get(familyId) as Row | undefined;
    if (!row) return createDefaultSettings(DEFAULT_EMAIL);
    return normalizeSettings(decryptJson<Partial<SettingsData>>(row.settings_cipher as string, this.key), DEFAULT_EMAIL);
  }

  updateSettings(input: Partial<SettingsData>, familyId = DEFAULT_FAMILY_ID): SettingsData {
    const next = normalizeSettings(input, DEFAULT_EMAIL, this.getSettings(familyId));
    const updatedAt = new Date().toISOString();
    const settings = { ...next, updatedAt };
    this.db
      .prepare(
        `INSERT INTO app_settings (family_id, settings_cipher, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(family_id) DO UPDATE SET
           settings_cipher = excluded.settings_cipher,
           updated_at = excluded.updated_at`
      )
      .run(familyId, encryptJson(settings, this.key), updatedAt);
    this.audit("parent", "settings_updated", "settings", familyId, {
      users: settings.users.length,
      customBoxes: settings.customBoxes.length,
      customFields: settings.customFields.length,
      customTabs: settings.customTabs.length
    }, familyId);
    return settings;
  }

  listStudents(familyId = DEFAULT_FAMILY_ID): Student[] {
    return this.db
      .prepare("SELECT * FROM students WHERE family_id = ? ORDER BY created_at ASC")
      .all(familyId)
      .map((row) => this.studentFromRow(row));
  }

  createStudent(profile: StudentProfile, familyId = DEFAULT_FAMILY_ID): Student {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO students (id, family_id, name, graduation_year, school_state, profile_cipher, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, familyId, profile.preferredName, profile.graduationYear, profile.schoolState, encryptJson(profile, this.key), now);
    this.audit("parent", "student_created", "student", id, { name: profile.preferredName }, familyId);
    return this.getStudent(id, familyId)!;
  }

  updateStudent(id: string, profile: Partial<StudentProfile>, familyId = DEFAULT_FAMILY_ID): Student {
    const existing = this.getStudent(id, familyId);
    if (!existing) throw new Error(`Student not found: ${id}`);
    const mergedProfile = mergeStudentProfile(existing.profile, profile);
    this.db
      .prepare(
        `UPDATE students
         SET name = ?, graduation_year = ?, school_state = ?, profile_cipher = ?
         WHERE id = ? AND family_id = ?`
      )
      .run(
        mergedProfile.preferredName,
        mergedProfile.graduationYear,
        mergedProfile.schoolState,
        encryptJson(mergedProfile, this.key),
        id,
        familyId
      );
    this.audit("parent", "student_updated", "student", id, { name: mergedProfile.preferredName }, familyId);
    return this.getStudent(id, familyId)!;
  }

  syncStudents(students: Student[], familyId = DEFAULT_FAMILY_ID): Student[] {
    const seen = new Set<string>();
    const now = new Date().toISOString();
    for (const student of students) {
      if (!student.id || seen.has(student.id)) continue;
      seen.add(student.id);
      const profile = student.profile;
      if (!profile?.preferredName || !profile.legalName || !profile.schoolState || !Number.isFinite(Number(profile.graduationYear))) continue;
      const createdAt = student.createdAt || now;
      this.db
        .prepare(
          `INSERT INTO students (id, family_id, name, graduation_year, school_state, profile_cipher, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             family_id = excluded.family_id,
             name = excluded.name,
             graduation_year = excluded.graduation_year,
             school_state = excluded.school_state,
             profile_cipher = excluded.profile_cipher`
        )
        .run(
          student.id,
          familyId,
          profile.preferredName,
          profile.graduationYear,
          profile.schoolState,
          encryptJson(profile, this.key),
          createdAt
        );
    }
    this.audit("parent", "student_profiles_synced", "student", "client_profiles", { count: seen.size }, familyId);
    return this.listStudents(familyId);
  }

  deleteStudent(id: string, familyId = DEFAULT_FAMILY_ID): Student | undefined {
    const student = this.getStudent(id, familyId);
    if (!student) return undefined;
    const planRows = this.db
      .prepare("SELECT id FROM application_plans WHERE student_id = ? AND family_id = ?")
      .all(id, familyId) as Row[];
    for (const row of planRows) {
      this.db
        .prepare("DELETE FROM approvals WHERE target_type = 'application_plan' AND target_id = ? AND family_id = ?")
        .run(row.id as string, familyId);
    }
    this.db.prepare("DELETE FROM students WHERE id = ? AND family_id = ?").run(id, familyId);
    this.audit("parent", "student_deleted", "student", id, { name: student.profile.preferredName }, familyId);
    return student;
  }

  getStudent(id: string, familyId = DEFAULT_FAMILY_ID): Student | undefined {
    const row = this.db.prepare("SELECT * FROM students WHERE id = ? AND family_id = ?").get(id, familyId);
    return row ? this.studentFromRow(row) : undefined;
  }

  upsertScholarship(
    input: DiscoveredScholarship,
    fitScore = 0,
    effort: Scholarship["effort"] = "medium",
    familyId = DEFAULT_FAMILY_ID
  ): Scholarship {
    const existing = this.db.prepare("SELECT id FROM scholarships WHERE url = ? AND family_id = ?").get(input.url, familyId) as
      | Row
      | undefined;
    const id = existing?.id as string | undefined ?? randomUUID();
    const status = fitScore > 0 ? "matched" : "new";
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scholarships (
          id, family_id, title, provider, url, award, deadline, status, fit_score, effort,
          requirements_json, risks_json, tags_json, source_quote, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(family_id, url) DO UPDATE SET
          title = excluded.title,
          provider = excluded.provider,
          award = excluded.award,
          deadline = excluded.deadline,
          status = excluded.status,
          fit_score = excluded.fit_score,
          effort = excluded.effort,
          requirements_json = excluded.requirements_json,
          risks_json = excluded.risks_json,
          tags_json = excluded.tags_json,
          source_quote = excluded.source_quote`
      )
      .run(
        id,
        familyId,
        input.title,
        input.provider,
        input.url,
        input.award,
        input.deadline,
        status,
        fitScore,
        effort,
        JSON.stringify(input.requirements),
        JSON.stringify(input.risks),
        JSON.stringify(input.tags),
        input.sourceQuote,
        now
      );
    return this.getScholarship(id, familyId)!;
  }

  updateScholarshipScore(
    id: string,
    fitScore: number,
    effort: Scholarship["effort"],
    status: ScholarshipStatus = "matched",
    familyId = DEFAULT_FAMILY_ID
  ) {
    this.db
      .prepare("UPDATE scholarships SET fit_score = ?, effort = ?, status = ? WHERE id = ? AND family_id = ?")
      .run(fitScore, effort, status, id, familyId);
  }

  getScholarship(id: string, familyId = DEFAULT_FAMILY_ID): Scholarship | undefined {
    const row = this.db.prepare("SELECT * FROM scholarships WHERE id = ? AND family_id = ?").get(id, familyId);
    return row ? this.scholarshipFromRow(row) : undefined;
  }

  listScholarships(familyId = DEFAULT_FAMILY_ID): Scholarship[] {
    return this.db
      .prepare("SELECT * FROM scholarships WHERE family_id = ? ORDER BY fit_score DESC, deadline ASC")
      .all(familyId)
      .map((row) => this.scholarshipFromRow(row));
  }

  createDocument(input: Omit<DocumentRecord, "id" | "familyId" | "uploadedAt">, familyId = DEFAULT_FAMILY_ID): DocumentRecord {
    const id = randomUUID();
    const uploadedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO documents (
          id, family_id, student_id, type, category, name, path, storage_provider,
          blob_path, content_type, size_bytes, status, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        familyId,
        input.studentId,
        input.type,
        input.category ?? input.type,
        input.name,
        input.path,
        input.storageProvider ?? "local",
        input.blobPath ?? null,
        input.contentType ?? null,
        input.sizeBytes ?? null,
        input.status,
        uploadedAt
    );
    this.audit("parent", "document_registered", "document", id, { type: input.type, name: input.name }, familyId);
    return this.documentFromRow(this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row);
  }

  upsertDocument(input: DocumentRecord, familyId = DEFAULT_FAMILY_ID): DocumentRecord {
    this.db
      .prepare(
        `INSERT INTO documents (
          id, family_id, student_id, type, category, name, path, storage_provider,
          blob_path, content_type, size_bytes, status, uploaded_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          family_id = excluded.family_id,
          student_id = excluded.student_id,
          type = excluded.type,
          category = excluded.category,
          name = excluded.name,
          path = excluded.path,
          storage_provider = excluded.storage_provider,
          blob_path = excluded.blob_path,
          content_type = excluded.content_type,
          size_bytes = excluded.size_bytes,
          status = excluded.status,
          uploaded_at = excluded.uploaded_at`
      )
      .run(
        input.id,
        familyId,
        input.studentId,
        input.type,
        input.category ?? input.type,
        input.name,
        input.path,
        input.storageProvider ?? "local",
        input.blobPath ?? null,
        input.contentType ?? null,
        input.sizeBytes ?? null,
        input.status,
        input.uploadedAt
      );
    this.audit("parent", "document_synced", "document", input.id, { type: input.type, name: input.name }, familyId);
    return this.documentFromRow(this.db.prepare("SELECT * FROM documents WHERE id = ? AND family_id = ?").get(input.id, familyId) as Row);
  }

  deleteDocument(id: string, familyId = DEFAULT_FAMILY_ID): DocumentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ? AND family_id = ?").get(id, familyId) as Row | undefined;
    if (!row) return undefined;
    const document = this.documentFromRow(row);
    this.db.prepare("DELETE FROM documents WHERE id = ? AND family_id = ?").run(id, familyId);
    this.audit("parent", "document_deleted", "document", id, { type: document.type, name: document.name }, familyId);
    return document;
  }

  updateDocument(id: string, input: Partial<Omit<DocumentRecord, "id" | "familyId" | "uploadedAt">>, familyId = DEFAULT_FAMILY_ID): DocumentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ? AND family_id = ?").get(id, familyId) as Row | undefined;
    if (!row) return undefined;
    const previous = this.documentFromRow(row);
    const document: DocumentRecord = {
      ...previous,
      studentId: input.studentId ?? previous.studentId,
      type: input.type ?? previous.type,
      category: input.category ?? previous.category,
      name: input.name ?? previous.name,
      path: input.path ?? previous.path,
      storageProvider: input.storageProvider ?? previous.storageProvider,
      blobPath: input.blobPath ?? previous.blobPath,
      contentType: input.contentType ?? previous.contentType,
      sizeBytes: input.sizeBytes ?? previous.sizeBytes,
      status: input.status ?? previous.status
    };
    this.db
      .prepare(
        `UPDATE documents
         SET student_id = ?, type = ?, category = ?, name = ?, path = ?, storage_provider = ?,
             blob_path = ?, content_type = ?, size_bytes = ?, status = ?
         WHERE id = ? AND family_id = ?`
      )
      .run(
        document.studentId,
        document.type,
        document.category ?? document.type,
        document.name,
        document.path,
        document.storageProvider ?? "local",
        document.blobPath ?? null,
        document.contentType ?? null,
        document.sizeBytes ?? null,
        document.status,
        id,
        familyId
      );
    this.audit("parent", "document_updated", "document", id, { studentId: document.studentId, type: document.type, name: document.name }, familyId);
    return document;
  }

  listDocuments(familyId = DEFAULT_FAMILY_ID): DocumentRecord[] {
    return this.db
      .prepare("SELECT * FROM documents WHERE family_id = ? ORDER BY uploaded_at DESC")
      .all(familyId)
      .map((row) => this.documentFromRow(row));
  }

  upsertEssayDraft(input: Omit<EssayDraft, "id" | "familyId" | "updatedAt">, familyId = DEFAULT_FAMILY_ID): EssayDraft {
    const existing = this.db
      .prepare("SELECT id FROM essay_drafts WHERE student_id = ? AND scholarship_id = ? AND family_id = ?")
      .get(input.studentId, input.scholarshipId, familyId) as Row | undefined;
    const id = existing?.id as string | undefined ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO essay_drafts (
          id, family_id, student_id, scholarship_id, prompt, interview_json, draft, unsupported_claims_json, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id, scholarship_id) DO UPDATE SET
          prompt = excluded.prompt,
          interview_json = excluded.interview_json,
          draft = excluded.draft,
          unsupported_claims_json = excluded.unsupported_claims_json,
          status = excluded.status,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        familyId,
        input.studentId,
        input.scholarshipId,
        input.prompt,
        JSON.stringify(input.interview),
        input.draft,
        JSON.stringify(input.unsupportedClaims),
        input.status,
        now
      );
    this.audit("agent", "essay_draft_updated", "essay", id, { scholarshipId: input.scholarshipId, status: input.status }, familyId);
    return this.listEssayDrafts(familyId).find((draft) => draft.id === id)!;
  }

  listEssayDrafts(familyId = DEFAULT_FAMILY_ID): EssayDraft[] {
    return this.db
      .prepare("SELECT * FROM essay_drafts WHERE family_id = ? ORDER BY updated_at DESC")
      .all(familyId)
      .map((row) => this.essayDraftFromRow(row));
  }

  upsertApplicationPlan(input: Omit<ApplicationPlan, "id" | "familyId" | "createdAt">, familyId = DEFAULT_FAMILY_ID): ApplicationPlan {
    const existing = this.db
      .prepare("SELECT id FROM application_plans WHERE student_id = ? AND scholarship_id = ? AND family_id = ?")
      .get(input.studentId, input.scholarshipId, familyId) as Row | undefined;
    const id = existing?.id as string | undefined ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO application_plans (
          id, family_id, scholarship_id, student_id, field_map_json, missing_fields_json,
          document_requests_json, browser_steps_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id, scholarship_id) DO UPDATE SET
          field_map_json = excluded.field_map_json,
          missing_fields_json = excluded.missing_fields_json,
          document_requests_json = excluded.document_requests_json,
          browser_steps_json = excluded.browser_steps_json,
          status = excluded.status`
      )
      .run(
        id,
        familyId,
        input.scholarshipId,
        input.studentId,
        JSON.stringify(input.fieldMap),
        JSON.stringify(input.missingFields),
        JSON.stringify(input.documentRequests),
        JSON.stringify(input.browserSteps),
        input.status,
        now
      );
    this.audit("agent", "application_plan_prepared", "application_plan", id, {
      scholarshipId: input.scholarshipId,
      missingFields: input.missingFields.length
    }, familyId);
    return this.listApplicationPlans(familyId).find((plan) => plan.id === id)!;
  }

  replaceApplicationPlan(
    id: string,
    input: Omit<ApplicationPlan, "id" | "familyId" | "createdAt">,
    familyId = DEFAULT_FAMILY_ID
  ): ApplicationPlan {
    const existing = this.listApplicationPlans(familyId).find((plan) => plan.id === id);
    if (!existing) throw new Error(`Application plan not found: ${id}`);
    this.db
      .prepare(
        `UPDATE application_plans
         SET scholarship_id = ?,
             student_id = ?,
             field_map_json = ?,
             missing_fields_json = ?,
             document_requests_json = ?,
             browser_steps_json = ?,
             status = ?
         WHERE id = ? AND family_id = ?`
      )
      .run(
        input.scholarshipId,
        input.studentId,
        JSON.stringify(input.fieldMap),
        JSON.stringify(input.missingFields),
        JSON.stringify(input.documentRequests),
        JSON.stringify(input.browserSteps),
        input.status,
        id,
        familyId
      );
    this.audit("parent", "application_plan_profile_selected", "application_plan", id, {
      scholarshipId: input.scholarshipId,
      studentId: input.studentId,
      missingFields: input.missingFields.length
    }, familyId);
    return this.listApplicationPlans(familyId).find((plan) => plan.id === id)!;
  }

  refreshApplicationPlanApprovalSummaries(
    planId: string,
    scholarshipTitle: string,
    studentName: string,
    familyId = DEFAULT_FAMILY_ID
  ): void {
    this.db
      .prepare(
        `UPDATE approvals
         SET summary = ?
         WHERE family_id = ?
           AND target_type = 'application_plan'
           AND target_id = ?
           AND action_type = 'portal_submit'
           AND status = 'pending'`
      )
      .run(`Review ${scholarshipTitle} for ${studentName}. The app will not submit without this approval.`, familyId, planId);
  }

  listApplicationPlans(familyId = DEFAULT_FAMILY_ID): ApplicationPlan[] {
    return this.db
      .prepare("SELECT * FROM application_plans WHERE family_id = ? ORDER BY created_at DESC")
      .all(familyId)
      .map((row) => this.applicationPlanFromRow(row));
  }

  getApplicationPlan(id: string, familyId = DEFAULT_FAMILY_ID): ApplicationPlan | undefined {
    const row = this.db.prepare("SELECT * FROM application_plans WHERE id = ? AND family_id = ?").get(id, familyId) as Row | undefined;
    return row ? this.applicationPlanFromRow(row) : undefined;
  }

  createSubmissionSession(
    input: Omit<
      SubmissionSession,
      | "id"
      | "familyId"
      | "createdAt"
      | "updatedAt"
      | "confirmationText"
      | "screenshotName"
      | "screenshotPath"
      | "submittedAt"
    >,
    familyId = DEFAULT_FAMILY_ID
  ): SubmissionSession {
    const existing = this.db
      .prepare("SELECT * FROM submission_sessions WHERE application_plan_id = ? AND family_id = ?")
      .get(input.applicationPlanId, familyId) as Row | undefined;
    if (existing && existing.status === "submitted") return this.submissionSessionFromRow(existing);

    const id = (existing?.id as string | undefined) ?? randomUUID();
    const createdAt = (existing?.created_at as string | undefined) ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO submission_sessions (
          id, family_id, application_plan_id, scholarship_id, student_id, status,
          chrome_profile, chrome_profile_label, launch_url, safe_mode,
          steps_json, blocked_actions_json, blockers_json, review_stop_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(family_id, application_plan_id) DO UPDATE SET
          scholarship_id = excluded.scholarship_id,
          student_id = excluded.student_id,
          status = excluded.status,
          chrome_profile = excluded.chrome_profile,
          chrome_profile_label = excluded.chrome_profile_label,
          launch_url = excluded.launch_url,
          safe_mode = excluded.safe_mode,
          steps_json = excluded.steps_json,
          blocked_actions_json = excluded.blocked_actions_json,
          blockers_json = excluded.blockers_json,
          review_stop_json = excluded.review_stop_json,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        familyId,
        input.applicationPlanId,
        input.scholarshipId,
        input.studentId,
        input.status,
        input.chromeProfile,
        input.chromeProfileLabel,
        input.launchUrl,
        input.safeMode ? 1 : 0,
        JSON.stringify(input.steps),
        JSON.stringify(input.blockedActions),
        JSON.stringify(input.blockers),
        JSON.stringify(input.reviewStop),
        createdAt,
        updatedAt
      );
    this.audit("agent", "submission_session_created", "application_plan", input.applicationPlanId, {
      status: input.status,
      blockers: input.blockers
    }, familyId);
    return this.getSubmissionSession(id, familyId)!;
  }

  getSubmissionSession(id: string, familyId = DEFAULT_FAMILY_ID): SubmissionSession | undefined {
    const row = this.db.prepare("SELECT * FROM submission_sessions WHERE id = ? AND family_id = ?").get(id, familyId) as Row | undefined;
    return row ? this.submissionSessionFromRow(row) : undefined;
  }

  getSubmissionSessionForPlan(planId: string, familyId = DEFAULT_FAMILY_ID): SubmissionSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM submission_sessions WHERE application_plan_id = ? AND family_id = ?")
      .get(planId, familyId) as Row | undefined;
    return row ? this.submissionSessionFromRow(row) : undefined;
  }

  listSubmissionSessions(familyId = DEFAULT_FAMILY_ID): SubmissionSession[] {
    return this.db
      .prepare("SELECT * FROM submission_sessions WHERE family_id = ? ORDER BY updated_at DESC")
      .all(familyId)
      .map((row) => this.submissionSessionFromRow(row));
  }

  startSubmissionSession(id: string, familyId = DEFAULT_FAMILY_ID): SubmissionSession {
    const session = this.getSubmissionSession(id, familyId);
    if (!session) throw new Error(`Submission session not found: ${id}`);
    if (session.status === "blocked" || session.status === "submitted") return session;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE submission_sessions SET status = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .run("waiting_for_manual_submit", updatedAt, id, familyId);
    this.audit("agent", "chrome_submission_session_started", "submission_session", id, {
      applicationPlanId: session.applicationPlanId,
      chromeProfile: session.chromeProfileLabel,
      launchUrl: session.launchUrl,
      manualSubmitRequired: true
    }, familyId);
    return this.getSubmissionSession(id, familyId)!;
  }

  updateSubmissionSessionStatus(
    id: string,
    status: SubmissionSessionStatus,
    familyId = DEFAULT_FAMILY_ID,
    blockers?: string[]
  ): SubmissionSession {
    const session = this.getSubmissionSession(id, familyId);
    if (!session) throw new Error(`Submission session not found: ${id}`);
    if (session.status === "submitted") return session;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE submission_sessions SET status = ?, blockers_json = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .run(status, JSON.stringify(blockers ?? session.blockers), updatedAt, id, familyId);
    this.audit("agent", "submission_session_status_updated", "submission_session", id, {
      applicationPlanId: session.applicationPlanId,
      status,
      blockers: blockers ?? session.blockers
    }, familyId);
    return this.getSubmissionSession(id, familyId)!;
  }

  confirmSubmissionSession(
    id: string,
    input: { confirmationText: string; screenshotName?: string; screenshotPath?: string },
    familyId = DEFAULT_FAMILY_ID
  ): SubmissionSession {
    const session = this.getSubmissionSession(id, familyId);
    if (!session) throw new Error(`Submission session not found: ${id}`);
    if (session.status === "blocked" || session.status === "failed") {
      throw new Error("Resolve blocked review items before recording a submitted application.");
    }
    const confirmationText = input.confirmationText.trim();
    if (!confirmationText) throw new Error("Confirmation text or number is required.");
    const submittedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE submission_sessions
         SET status = 'submitted',
             confirmation_text = ?,
             screenshot_name = ?,
             screenshot_path = ?,
             submitted_at = ?,
             updated_at = ?
         WHERE id = ? AND family_id = ?`
      )
      .run(confirmationText, input.screenshotName ?? null, input.screenshotPath ?? null, submittedAt, submittedAt, id, familyId);
    this.db
      .prepare("UPDATE scholarships SET status = 'submitted' WHERE id = ? AND family_id = ?")
      .run(session.scholarshipId, familyId);
    this.audit("parent", "submission_confirmed", "submission_session", id, {
      applicationPlanId: session.applicationPlanId,
      scholarshipId: session.scholarshipId,
      studentId: session.studentId,
      confirmationText,
      screenshotName: input.screenshotName ?? ""
    }, familyId);
    return this.getSubmissionSession(id, familyId)!;
  }

  createApprovalIfMissing(input: Omit<Approval, "id" | "familyId" | "status" | "requestedAt">, familyId = DEFAULT_FAMILY_ID): Approval {
    const existing = this.db
      .prepare(
        "SELECT * FROM approvals WHERE action_type = ? AND target_type = ? AND target_id = ? AND family_id = ? AND status = 'pending'"
      )
      .get(input.actionType, input.targetType, input.targetId, familyId);
    if (existing) return this.approvalFromRow(existing);

    const id = randomUUID();
    const requestedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals (
          id, family_id, action_type, target_type, target_id, summary, risk_level, status, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, familyId, input.actionType, input.targetType, input.targetId, input.summary, input.riskLevel, requestedAt);
    this.audit("agent", "approval_requested", input.targetType, input.targetId, {
      actionType: input.actionType,
      riskLevel: input.riskLevel
    }, familyId);
    return this.listApprovals(familyId).find((approval) => approval.id === id)!;
  }

  supersedeStaleApplicationReviewApprovals(activePlanIds: string[], familyId = DEFAULT_FAMILY_ID): number {
    const active = new Set(activePlanIds.filter(Boolean));
    const staleRows = this.db
      .prepare(
        `SELECT * FROM approvals
         WHERE family_id = ?
           AND action_type = 'portal_submit'
           AND target_type = 'application_plan'
           AND status = 'pending'`
      )
      .all(familyId)
      .filter((row) => !active.has(String((row as Row).target_id)));

    if (!staleRows.length) return 0;

    const now = new Date().toISOString();
    const update = this.db.prepare(
      "UPDATE approvals SET status = 'superseded', decided_at = ?, decision_note = ? WHERE id = ? AND family_id = ?"
    );
    for (const row of staleRows) {
      update.run(now, "Replaced by a newer no-essay search.", (row as Row).id as string, familyId);
    }
    this.audit("agent", "application_review_queue_superseded", "approval", familyId, {
      count: staleRows.length,
      activePlanIds: [...active]
    }, familyId);
    return staleRows.length;
  }

  decideApproval(id: string, status: Extract<ApprovalStatus, "approved" | "rejected">, note = "", familyId = DEFAULT_FAMILY_ID): Approval {
    const decidedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND family_id = ?")
      .run(status, decidedAt, note, id, familyId);
    const approval = this.listApprovals(familyId).find((item) => item.id === id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    this.audit("parent", `approval_${status}`, approval.targetType, approval.targetId, {
      actionType: approval.actionType,
      note
    }, familyId);
    return approval;
  }

  listApprovals(familyId = DEFAULT_FAMILY_ID): Approval[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE family_id = ? ORDER BY requested_at DESC")
      .all(familyId)
      .map((row) => this.approvalFromRow(row));
  }

  audit(
    actor: AuditEvent["actor"],
    eventType: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
    familyId = DEFAULT_FAMILY_ID
  ) {
    this.db
      .prepare(
        "INSERT INTO audit_events (id, family_id, actor, event_type, target_type, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), familyId, actor, eventType, targetType, targetId, JSON.stringify(detail), new Date().toISOString());
  }

  listAuditEvents(familyId = DEFAULT_FAMILY_ID): AuditEvent[] {
    return this.db
      .prepare("SELECT * FROM audit_events WHERE family_id = ? ORDER BY created_at DESC LIMIT 80")
      .all(familyId)
      .map((row) => this.auditFromRow(row));
  }

  startAgentRun(runType: AgentRun["runType"], summary: string, familyId = DEFAULT_FAMILY_ID): AgentRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO agent_runs (id, family_id, run_type, status, summary, created_at, output_json) VALUES (?, ?, ?, 'running', ?, ?, '{}')"
      )
      .run(id, familyId, runType, summary, createdAt);
    return this.listAgentRuns(familyId).find((run) => run.id === id)!;
  }

  completeAgentRun(
    id: string,
    summary: string,
    output: Record<string, unknown>,
    status: AgentRun["status"] = "completed",
    familyId = DEFAULT_FAMILY_ID
  ): AgentRun {
    this.db
      .prepare("UPDATE agent_runs SET status = ?, summary = ?, completed_at = ?, output_json = ? WHERE id = ? AND family_id = ?")
      .run(status, summary, new Date().toISOString(), JSON.stringify(output), id, familyId);
    const run = this.listAgentRuns(familyId).find((item) => item.id === id);
    if (!run) throw new Error(`Agent run not found: ${id}`);
    return run;
  }

  listAgentRuns(familyId = DEFAULT_FAMILY_ID): AgentRun[] {
    return this.db
      .prepare("SELECT * FROM agent_runs WHERE family_id = ? ORDER BY created_at DESC LIMIT 25")
      .all(familyId)
      .map((row) => this.agentRunFromRow(row));
  }

  upsertSaaSFamily(input: {
    id?: string;
    clerkOrgId: string;
    name: string;
    status?: FamilyStatus;
  }): Family {
    const now = new Date().toISOString();
    const id = input.id ?? `family_${input.clerkOrgId}`;
    this.db
      .prepare(
        `INSERT INTO families (id, clerk_org_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(clerk_org_id) DO UPDATE SET
           name = excluded.name,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(id, input.clerkOrgId, input.name, input.status ?? "beta_active", now, now);
    const family = this.db.prepare("SELECT * FROM families WHERE clerk_org_id = ?").get(input.clerkOrgId) as Row;
    return this.familyFromRow(family);
  }

  listFamilyMembers(familyId = DEFAULT_FAMILY_ID): FamilyMember[] {
    return this.db
      .prepare("SELECT * FROM family_members WHERE family_id = ? ORDER BY created_at ASC")
      .all(familyId)
      .map((row) => this.familyMemberFromRow(row));
  }

  upsertFamilyMember(input: Omit<FamilyMember, "id" | "createdAt" | "updatedAt">): FamilyMember {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM family_members WHERE family_id = ? AND clerk_user_id = ?")
      .get(input.familyId, input.clerkUserId) as Row | undefined;
    const id = existing?.id as string | undefined ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO family_members (
          id, family_id, clerk_user_id, email, role, profile_ids_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(family_id, clerk_user_id) DO UPDATE SET
          email = excluded.email,
          role = excluded.role,
          profile_ids_json = excluded.profile_ids_json,
          status = excluded.status,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.familyId,
        input.clerkUserId,
        input.email.toLowerCase(),
        normalizeSaaSRole(input.role),
        JSON.stringify(input.role === "Admin" ? [] : input.profileIds),
        input.status,
        now,
        now
      );
    const row = this.db.prepare("SELECT * FROM family_members WHERE id = ?").get(id) as Row;
    return this.familyMemberFromRow(row);
  }

  createBetaInvite(input: Omit<BetaInvite, "id" | "createdAt" | "updatedAt">): BetaInvite {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO beta_invites (
          id, family_id, clerk_invitation_id, email, role, invited_by, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.familyId,
        input.clerkInvitationId ?? null,
        input.email.toLowerCase(),
        normalizeSaaSRole(input.role),
        input.invitedBy,
        input.status,
        now,
        now
      );
    this.audit("system", "beta_invite_created", "family", input.familyId, {
      email: input.email,
      role: input.role,
      clerkInvitationId: input.clerkInvitationId ?? ""
    }, input.familyId);
    return this.betaInviteFromRow(this.db.prepare("SELECT * FROM beta_invites WHERE id = ?").get(id) as Row);
  }

  acquireAgentRunLock(familyId: string, runType: AgentRun["runType"], ttlMs = 55 * 60 * 1000): AgentRunLock | undefined {
    const now = new Date();
    const nowIso = now.toISOString();
    const lockUntil = new Date(now.getTime() + ttlMs).toISOString();
    const existing = this.db
      .prepare("SELECT * FROM agent_run_locks WHERE family_id = ? AND run_type = ?")
      .get(familyId, runType) as Row | undefined;
    if (existing && String(existing.lock_until) > nowIso) return undefined;
    this.db
      .prepare(
        `INSERT INTO agent_run_locks (family_id, run_type, lock_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(family_id, run_type) DO UPDATE SET
          lock_until = excluded.lock_until,
          updated_at = excluded.updated_at`
      )
      .run(familyId, runType, lockUntil, existing?.created_at ?? nowIso, nowIso);
    return this.agentRunLockFromRow(
      this.db.prepare("SELECT * FROM agent_run_locks WHERE family_id = ? AND run_type = ?").get(familyId, runType) as Row
    );
  }

  releaseAgentRunLock(familyId: string, runType: AgentRun["runType"]): void {
    this.db.prepare("DELETE FROM agent_run_locks WHERE family_id = ? AND run_type = ?").run(familyId, runType);
  }

  createCompanionToken(
    submissionSessionId: string,
    familyId = DEFAULT_FAMILY_ID,
    ttlMs = 15 * 60 * 1000
  ): { companionToken: CompanionToken; token: string } {
    const session = this.getSubmissionSession(submissionSessionId, familyId);
    if (!session) throw new Error(`Submission session not found: ${submissionSessionId}`);
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO companion_tokens (id, family_id, submission_session_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, familyId, submissionSessionId, tokenHash, expiresAt, now);
    const companionToken = this.companionTokenFromRow(this.db.prepare("SELECT * FROM companion_tokens WHERE id = ?").get(id) as Row);
    this.audit("agent", "companion_token_created", "submission_session", submissionSessionId, {
      expiresAt
    }, familyId);
    return { companionToken, token };
  }

  consumeCompanionToken(token: string): CompanionToken | undefined {
    const now = new Date().toISOString();
    const tokenHash = hashSessionToken(token);
    const row = this.db
      .prepare("SELECT * FROM companion_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(tokenHash, now) as Row | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE companion_tokens SET used_at = ? WHERE id = ?").run(now, row.id as string);
    return this.companionTokenFromRow({ ...row, used_at: now });
  }

  seedIfEmpty(familyId = DEFAULT_FAMILY_ID) {
    if (this.listStudents(familyId).length > 0) return;
    const student = this.createStudent(sampleStudentProfile(), familyId);
    this.createDocument({
      studentId: student.id,
      type: "resume",
      name: "Student activities resume",
      path: "data/documents/resume-placeholder.pdf",
      status: "available"
    }, familyId);
    this.createDocument({
      studentId: student.id,
      type: "transcript",
      name: "Unofficial transcript",
      path: "data/documents/transcript-placeholder.pdf",
      status: "needs_update"
    }, familyId);
    this.audit("system", "sample_workspace_seeded", "student", student.id, {
      note: "Created a sample high school student so the weekly pipeline can run immediately."
    }, familyId);
  }

  getDefaultFamilyId(): string {
    return DEFAULT_FAMILY_ID;
  }

  getFamily(id: string): Family | undefined {
    const row = this.db.prepare("SELECT * FROM families WHERE id = ?").get(id);
    return row ? this.familyFromRow(row) : undefined;
  }

  createPortalInviteForSettingsUser(
    user: SettingsData["users"][number],
    familyId = DEFAULT_FAMILY_ID
  ): { invite: PortalInvite; token: string } {
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * Number(process.env.PORTAL_INVITE_TTL_DAYS ?? 7)).toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO portal_invites (
          id, family_id, email, display_name, settings_role, token_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, familyId, user.email.toLowerCase(), user.name, user.role, tokenHash, expiresAt, now);
    const invite = this.portalInviteFromRow(this.db.prepare("SELECT * FROM portal_invites WHERE id = ?").get(id) as Row);
    this.audit("parent", "portal_invite_created", "user", user.id, {
      email: user.email,
      role: user.role,
      expiresAt
    }, familyId);
    return { invite, token };
  }

  recordPortalInviteDelivery(
    inviteId: string,
    result: InviteEmailResult,
    familyId = DEFAULT_FAMILY_ID
  ): PortalInvite | undefined {
    const inviteUrlCipher = result.inviteUrl ? encryptJson(result.inviteUrl, this.key) : null;
    this.db
      .prepare(
        `UPDATE portal_invites
         SET delivery_status = ?, delivery_error = ?, provider_message_id = ?, invite_url_cipher = ?
         WHERE id = ? AND family_id = ?`
      )
      .run(
        result.status,
        result.error ?? "",
        result.providerMessageId ?? "",
        inviteUrlCipher,
        inviteId,
        familyId
      );
    const row = this.db.prepare("SELECT * FROM portal_invites WHERE id = ? AND family_id = ?").get(inviteId, familyId) as Row | undefined;
    return row ? this.portalInviteFromRow(row) : undefined;
  }

  listPortalInviteSummaries(familyId = DEFAULT_FAMILY_ID, limit = 5): InviteSummary[] {
    const now = new Date().toISOString();
    return this.db
      .prepare("SELECT * FROM portal_invites WHERE family_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(familyId, limit)
      .map((row) => this.portalInviteFromRow(row))
      .map((invite) => this.portalInviteSummary(invite, now));
  }

  acceptPortalInvite(token: string, password: string): { user: PortalUser; token: string; expiresAt: string } {
    if (password.length < 10) throw new Error("Password must be at least 10 characters.");
    const tokenHash = hashSessionToken(token);
    const now = new Date().toISOString();
    const row = this.db
      .prepare("SELECT * FROM portal_invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?")
      .get(tokenHash, now) as Row | undefined;
    if (!row) throw new Error("Invite link is invalid or expired.");
    const invite = this.portalInviteFromRow(row);
    const existing = this.db.prepare("SELECT * FROM portal_users WHERE lower(email) = lower(?)").get(invite.email) as Row | undefined;
    let user: PortalUser;
    if (existing) {
      this.db
        .prepare("UPDATE portal_users SET display_name = ?, password_hash = ? WHERE id = ?")
        .run(invite.displayName, hashPassword(password), existing.id as string);
      user = this.portalUserFromRow({ ...existing, display_name: invite.displayName });
    } else {
      const userId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO portal_users (id, family_id, email, display_name, role, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(userId, invite.familyId, invite.email, invite.displayName, "parent", hashPassword(password), now);
      user = this.getPortalUserByEmail(invite.email)!;
    }
    this.db.prepare("UPDATE portal_invites SET accepted_at = ? WHERE id = ?").run(now, invite.id);
    this.audit("parent", "portal_invite_accepted", "user", user.id, {
      email: invite.email,
      settingsRole: invite.settingsRole
    }, invite.familyId);
    return this.createPortalSession(user);
  }

  authenticateUser(email: string, password: string): { user: PortalUser; token: string; expiresAt: string } | undefined {
    const row = this.db.prepare("SELECT * FROM portal_users WHERE lower(email) = lower(?)").get(email.trim()) as Row | undefined;
    if (!row || !verifyPassword(password, row.password_hash as string)) return undefined;
    const user = this.portalUserFromRow(row);
    const session = this.createPortalSession(user);
    this.audit("parent", "user_logged_in", "user", user.id, { email: user.email }, user.familyId);
    return session;
  }

  getPortalUserByEmail(email: string): PortalUser | undefined {
    const row = this.db.prepare("SELECT * FROM portal_users WHERE lower(email) = lower(?)").get(email.trim()) as Row | undefined;
    return row ? this.portalUserFromRow(row) : undefined;
  }

  private createPortalSession(user: PortalUser): { user: PortalUser; token: string; expiresAt: string } {
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
    this.db
      .prepare(
        "INSERT INTO portal_sessions (id, user_id, family_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), user.id, user.familyId, hashSessionToken(token), expiresAt, new Date().toISOString());
    return { user, token, expiresAt };
  }

  getUserBySessionToken(token: string | undefined): PortalUser | undefined {
    if (!token) return undefined;
    const tokenHash = hashSessionToken(token);
    const row = this.db
      .prepare(
        `SELECT u.*
         FROM portal_sessions s
         JOIN portal_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(tokenHash, new Date().toISOString()) as Row | undefined;
    return row ? this.portalUserFromRow(row) : undefined;
  }

  deleteSessionByToken(token: string | undefined): void {
    if (!token) return;
    this.db.prepare("DELETE FROM portal_sessions WHERE token_hash = ?").run(hashSessionToken(token));
  }

  getPortalCredentialsHint(): { email: string; password: string } {
    return { email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD };
  }

  private ensurePortalSeed(): void {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO families (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(DEFAULT_FAMILY_ID, "My Family", "beta_active", now, now);
    const userCount = this.db.prepare("SELECT COUNT(*) AS count FROM portal_users").get() as Row;
    if (Number(userCount.count) === 0) {
      this.db
        .prepare(
          `INSERT INTO portal_users (id, family_id, email, display_name, role, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), DEFAULT_FAMILY_ID, DEFAULT_EMAIL, "Parent", "parent", hashPassword(DEFAULT_PASSWORD), now);
    }
    this.db.prepare("UPDATE students SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE scholarships SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE documents SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE essay_drafts SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE application_plans SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE submission_sessions SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE approvals SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE audit_events SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
    this.db.prepare("UPDATE agent_runs SET family_id = ? WHERE family_id IS NULL OR family_id = ''").run(DEFAULT_FAMILY_ID);
  }

  private backfillPortalColumns(): void {
    const additions: Array<[string, string]> = [
      ["students", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["scholarships", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["documents", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["essay_drafts", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["application_plans", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["submission_sessions", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["approvals", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["audit_events", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["agent_runs", "family_id TEXT NOT NULL DEFAULT 'family_local'"],
      ["portal_invites", "delivery_status TEXT"],
      ["portal_invites", "delivery_error TEXT"],
      ["portal_invites", "provider_message_id TEXT"],
      ["portal_invites", "invite_url_cipher TEXT"]
    ];
    for (const [table, definition] of additions) {
      const column = definition.split(" ")[0];
      if (!this.hasColumn(table, column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_students_family ON students(family_id);
      CREATE INDEX IF NOT EXISTS idx_scholarships_family ON scholarships(family_id);
      CREATE INDEX IF NOT EXISTS idx_documents_family ON documents(family_id);
      CREATE INDEX IF NOT EXISTS idx_portal_invites_family ON portal_invites(family_id, email);
      CREATE INDEX IF NOT EXISTS idx_submission_sessions_family ON submission_sessions(family_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_submission_sessions_plan ON submission_sessions(family_id, application_plan_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_family ON approvals(family_id);
      CREATE INDEX IF NOT EXISTS idx_audit_family ON audit_events(family_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_family ON agent_runs(family_id, created_at);
    `);
  }

  private backfillSaaSColumns(): void {
    const additions: Array<[string, string]> = [
      ["families", "clerk_org_id TEXT"],
      ["families", "status TEXT NOT NULL DEFAULT 'beta_active'"],
      ["families", "updated_at TEXT"],
      ["documents", "category TEXT"],
      ["documents", "storage_provider TEXT NOT NULL DEFAULT 'local'"],
      ["documents", "blob_path TEXT"],
      ["documents", "content_type TEXT"],
      ["documents", "size_bytes INTEGER"]
    ];
    for (const [table, definition] of additions) {
      const column = definition.split(" ")[0];
      if (!this.hasColumn(table, column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE families SET status = COALESCE(NULLIF(status, ''), 'beta_active')").run();
    this.db.prepare("UPDATE families SET updated_at = COALESCE(updated_at, created_at, ?)").run(now);
    this.db.prepare("UPDATE documents SET category = COALESCE(category, type)").run();
    this.db.prepare("UPDATE documents SET storage_provider = COALESCE(NULLIF(storage_provider, ''), 'local')").run();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_families_clerk_org ON families(clerk_org_id) WHERE clerk_org_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id, status);
      CREATE INDEX IF NOT EXISTS idx_family_members_clerk_user ON family_members(clerk_user_id);
      CREATE INDEX IF NOT EXISTS idx_beta_invites_family ON beta_invites(family_id, status);
      CREATE INDEX IF NOT EXISTS idx_agent_run_locks_family ON agent_run_locks(family_id, run_type);
      CREATE INDEX IF NOT EXISTS idx_companion_tokens_hash ON companion_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_documents_blob ON documents(family_id, storage_provider, blob_path);
    `);
  }

  private normalizeScholarshipUniqueness(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scholarships'").get() as Row | undefined;
    const sql = String(row?.sql ?? "");
    if (!/url TEXT NOT NULL UNIQUE/i.test(sql)) return;

    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec(`
      CREATE TABLE scholarships_new (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL DEFAULT 'family_local',
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        url TEXT NOT NULL,
        award TEXT NOT NULL,
        deadline TEXT NOT NULL,
        status TEXT NOT NULL,
        fit_score INTEGER NOT NULL,
        effort TEXT NOT NULL,
        requirements_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_quote TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(family_id, url)
      );
      INSERT OR IGNORE INTO scholarships_new (
        id, family_id, title, provider, url, award, deadline, status, fit_score, effort,
        requirements_json, risks_json, tags_json, source_quote, created_at
      )
      SELECT
        id, family_id, title, provider, url, award, deadline, status, fit_score, effort,
        requirements_json, risks_json, tags_json, source_quote, created_at
      FROM scholarships;
      DROP TABLE scholarships;
      ALTER TABLE scholarships_new RENAME TO scholarships;
      CREATE INDEX IF NOT EXISTS idx_scholarships_family ON scholarships(family_id);
    `);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private hasColumn(table: string, column: string): boolean {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((row) => (row as Row).name === column);
  }

  private familyFromRow(row: Row): Family {
    return {
      id: row.id as string,
      clerkOrgId: row.clerk_org_id as string | undefined,
      name: row.name as string,
      status: row.status as FamilyStatus | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string | undefined
    };
  }

  private familyMemberFromRow(row: Row): FamilyMember {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      clerkUserId: row.clerk_user_id as string,
      email: row.email as string,
      role: normalizeSaaSRole(row.role as SaaSRole),
      profileIds: JSON.parse(row.profile_ids_json as string) as string[],
      status: row.status as FamilyMember["status"],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }

  private betaInviteFromRow(row: Row): BetaInvite {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      clerkInvitationId: row.clerk_invitation_id as string | undefined,
      email: row.email as string,
      role: normalizeSaaSRole(row.role as SaaSRole),
      invitedBy: row.invited_by as string,
      status: row.status as BetaInvite["status"],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }

  private agentRunLockFromRow(row: Row): AgentRunLock {
    return {
      familyId: row.family_id as string,
      runType: row.run_type as AgentRun["runType"],
      lockUntil: row.lock_until as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }

  private companionTokenFromRow(row: Row): CompanionToken {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      submissionSessionId: row.submission_session_id as string,
      tokenHash: row.token_hash as string,
      expiresAt: row.expires_at as string,
      usedAt: row.used_at as string | undefined,
      createdAt: row.created_at as string
    };
  }

  private portalUserFromRow(row: Row): PortalUser {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role as PortalUser["role"],
      createdAt: row.created_at as string
    };
  }

  private portalInviteFromRow(row: Row): PortalInvite {
    const inviteUrlCipher = row.invite_url_cipher as string | undefined;
    let inviteUrl: string | undefined;
    if (inviteUrlCipher) {
      try {
        inviteUrl = decryptJson<string>(inviteUrlCipher, this.key);
      } catch {
        inviteUrl = undefined;
      }
    }
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      settingsRole: row.settings_role as SettingsRole,
      tokenHash: row.token_hash as string,
      expiresAt: row.expires_at as string,
      acceptedAt: (row.accepted_at as string | null) || undefined,
      createdAt: row.created_at as string,
      deliveryStatus: (row.delivery_status as InviteEmailResult["status"] | null) || undefined,
      deliveryError: (row.delivery_error as string | null) || undefined,
      providerMessageId: (row.provider_message_id as string | null) || undefined,
      inviteUrl
    };
  }

  private portalInviteSummary(invite: PortalInvite, now = new Date().toISOString()): InviteSummary {
    const accepted = Boolean(invite.acceptedAt);
    const expired = !accepted && invite.expiresAt <= now;
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
      acceptedAt: invite.acceptedAt,
      inviteUrl: accepted || expired ? undefined : invite.inviteUrl,
      providerMessageId: invite.providerMessageId || undefined,
      error: invite.deliveryError || undefined
    };
  }

  private studentFromRow(row: Row): Student {
    const profile = decryptJson<StudentProfile>(row.profile_cipher as string, this.key);
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      name: row.name as string,
      graduationYear: row.graduation_year as number,
      schoolState: row.school_state as string,
      profile,
      createdAt: row.created_at as string
    };
  }

  private scholarshipFromRow(row: Row): Scholarship {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      title: row.title as string,
      provider: row.provider as string,
      url: row.url as string,
      award: row.award as string,
      deadline: row.deadline as string,
      status: row.status as ScholarshipStatus,
      fitScore: row.fit_score as number,
      effort: row.effort as Scholarship["effort"],
      requirements: JSON.parse(row.requirements_json as string) as ScholarshipRequirement[],
      risks: JSON.parse(row.risks_json as string) as string[],
      tags: JSON.parse(row.tags_json as string) as string[],
      sourceQuote: row.source_quote as string,
      createdAt: row.created_at as string
    };
  }

  private documentFromRow(row: Row): DocumentRecord {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      studentId: row.student_id as string,
      type: row.type as DocumentRecord["type"],
      category: row.category as string | undefined,
      name: row.name as string,
      path: row.path as string,
      storageProvider: row.storage_provider as DocumentRecord["storageProvider"] | undefined,
      blobPath: row.blob_path as string | undefined,
      contentType: row.content_type as string | undefined,
      sizeBytes: row.size_bytes as number | undefined,
      status: row.status as DocumentRecord["status"],
      uploadedAt: row.uploaded_at as string
    };
  }

  private essayDraftFromRow(row: Row): EssayDraft {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      studentId: row.student_id as string,
      scholarshipId: row.scholarship_id as string,
      prompt: row.prompt as string,
      interview: JSON.parse(row.interview_json as string) as EssayInterview,
      draft: row.draft as string,
      unsupportedClaims: JSON.parse(row.unsupported_claims_json as string) as string[],
      status: row.status as EssayDraft["status"],
      updatedAt: row.updated_at as string
    };
  }

  private applicationPlanFromRow(row: Row): ApplicationPlan {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      scholarshipId: row.scholarship_id as string,
      studentId: row.student_id as string,
      fieldMap: JSON.parse(row.field_map_json as string) as Record<string, string>,
      missingFields: JSON.parse(row.missing_fields_json as string) as string[],
      documentRequests: JSON.parse(row.document_requests_json as string) as string[],
      browserSteps: JSON.parse(row.browser_steps_json as string) as BrowserStep[],
      status: row.status as ApplicationPlan["status"],
      createdAt: row.created_at as string
    };
  }

  private submissionSessionFromRow(row: Row): SubmissionSession {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      applicationPlanId: row.application_plan_id as string,
      scholarshipId: row.scholarship_id as string,
      studentId: row.student_id as string,
      status: row.status as SubmissionSessionStatus,
      chromeProfile: row.chrome_profile as "scholarship",
      chromeProfileLabel: row.chrome_profile_label as string,
      launchUrl: row.launch_url as string,
      safeMode: Boolean(row.safe_mode) as true,
      steps: JSON.parse(row.steps_json as string) as BrowserStep[],
      blockedActions: JSON.parse(row.blocked_actions_json as string) as string[],
      blockers: JSON.parse(row.blockers_json as string) as string[],
      reviewStop: JSON.parse(row.review_stop_json as string) as BrowserStep,
      confirmationText: row.confirmation_text as string | undefined,
      screenshotName: row.screenshot_name as string | undefined,
      screenshotPath: row.screenshot_path as string | undefined,
      submittedAt: row.submitted_at as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }

  private approvalFromRow(row: Row): Approval {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      actionType: row.action_type as Approval["actionType"],
      targetType: row.target_type as Approval["targetType"],
      targetId: row.target_id as string,
      summary: row.summary as string,
      riskLevel: row.risk_level as Approval["riskLevel"],
      status: row.status as ApprovalStatus,
      requestedAt: row.requested_at as string,
      decidedAt: row.decided_at as string | undefined,
      decisionNote: row.decision_note as string | undefined
    };
  }

  private auditFromRow(row: Row): AuditEvent {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      actor: row.actor as AuditEvent["actor"],
      eventType: row.event_type as string,
      targetType: row.target_type as string,
      targetId: row.target_id as string,
      detail: JSON.parse(row.detail_json as string),
      createdAt: row.created_at as string
    };
  }

  private agentRunFromRow(row: Row): AgentRun {
    return {
      id: row.id as string,
      familyId: row.family_id as string,
      runType: row.run_type as AgentRun["runType"],
      status: row.status as AgentRun["status"],
      summary: row.summary as string,
      createdAt: row.created_at as string,
      completedAt: row.completed_at as string | undefined,
      output: JSON.parse(row.output_json as string)
    };
  }
}
