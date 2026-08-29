export type ID = string;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded";
export type ScholarshipStatus =
  | "new"
  | "matched"
  | "drafting"
  | "ready_for_review"
  | "submitted"
  | "archived";

export type EffortLevel = "low" | "medium" | "high";
export type FamilyStatus = "beta_active" | "suspended" | "archived";
export type SaaSRole = "Admin" | "Contributor" | "Guest" | "Viewer";

export interface Family {
  id: ID;
  clerkOrgId?: string;
  name: string;
  status?: FamilyStatus;
  createdAt: string;
  updatedAt?: string;
}

export interface FamilyMember {
  id: ID;
  familyId: ID;
  clerkUserId: string;
  email: string;
  role: SaaSRole;
  profileIds: ID[];
  status: "active" | "invited" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface BetaInvite {
  id: ID;
  familyId: ID;
  clerkInvitationId?: string;
  email: string;
  role: SaaSRole;
  invitedBy: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunLock {
  familyId: ID;
  runType: AgentRun["runType"];
  lockUntil: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionToken {
  id: ID;
  familyId: ID;
  submissionSessionId: ID;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface PortalUser {
  id: ID;
  familyId: ID;
  email: string;
  displayName: string;
  role: "parent" | "student";
  createdAt: string;
}

export interface PortalSession {
  id: ID;
  userId: ID;
  familyId: ID;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface PortalInvite {
  id: ID;
  familyId: ID;
  email: string;
  displayName: string;
  settingsRole: SettingsRole;
  tokenHash: string;
  expiresAt: string;
  acceptedAt?: string;
  createdAt: string;
  deliveryStatus?: InviteEmailResult["status"];
  deliveryError?: string;
  providerMessageId?: string;
  inviteUrl?: string;
}

export interface InviteEmailResult {
  email: string;
  status: "sent" | "not_configured" | "failed" | "manual";
  inviteUrl?: string;
  providerMessageId?: string;
  error?: string;
}

export interface InviteSummary {
  id: ID;
  email: string;
  status: InviteEmailResult["status"] | "accepted" | "expired";
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  inviteUrl?: string;
  providerMessageId?: string;
  error?: string;
}

export interface EssayInterview {
  proudMoment: string;
  communityImpact: string;
  challenge: string;
  futureGoal: string;
  voiceNotes: string;
}

export interface StudentProfile {
  preferredName: string;
  legalName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  gender?: string;
  dateOfBirth?: string;
  graduationYear: number;
  graduationMonth?: string;
  gradeLevel: "freshman" | "sophomore" | "junior" | "senior";
  schoolState: string;
  highSchoolName?: string;
  gpa?: number;
  citizenship: "us_citizen" | "permanent_resident" | "other" | "unknown";
  firstGeneration?: boolean;
  financialNeed?: "yes" | "no" | "unknown";
  intendedMajors: string[];
  collegesConsidering?: string[];
  activities: string[];
  serviceHours?: number;
  awards: string[];
  streetAddress?: string;
  city?: string;
  postalCode?: string;
  constraints: string[];
  essayInterview: EssayInterview;
}

export interface Student {
  id: ID;
  familyId: ID;
  name: string;
  graduationYear: number;
  schoolState: string;
  profile: StudentProfile;
  createdAt: string;
}

export interface ScholarshipRequirement {
  kind:
    | "grade"
    | "gpa"
    | "citizenship"
    | "location"
    | "major"
    | "essay"
    | "service"
    | "need"
    | "recommendation"
    | "attestation"
    | "document"
    | "signature"
    | "payment";
  label: string;
  required: boolean;
  value?: string | number | boolean;
}

export interface Scholarship {
  id: ID;
  familyId: ID;
  title: string;
  provider: string;
  url: string;
  award: string;
  deadline: string;
  status: ScholarshipStatus;
  fitScore: number;
  effort: EffortLevel;
  requirements: ScholarshipRequirement[];
  risks: string[];
  tags: string[];
  sourceQuote: string;
  createdAt: string;
}

export interface DiscoveredScholarship {
  title: string;
  provider: string;
  url: string;
  award: string;
  deadline: string;
  requirements: ScholarshipRequirement[];
  risks: string[];
  tags: string[];
  sourceQuote: string;
}

export interface DocumentRecord {
  id: ID;
  familyId: ID;
  studentId: ID;
  type: "resume" | "transcript" | "recommendation" | "essay" | "other";
  category?: string;
  name: string;
  path: string;
  storageProvider?: "local" | "vercel_blob";
  blobPath?: string;
  contentType?: string;
  sizeBytes?: number;
  status: "available" | "missing" | "needs_update";
  uploadedAt: string;
}

export interface EssayDraft {
  id: ID;
  familyId: ID;
  studentId: ID;
  scholarshipId: ID;
  prompt: string;
  interview: EssayInterview;
  draft: string;
  unsupportedClaims: string[];
  status: "draft" | "needs_student_review" | "approved";
  updatedAt: string;
}

export type BrowserStep =
  | { action: "navigate"; url: string; note: string }
  | { action: "fill"; selector: string; value: string; source: string; aliases?: string[]; label?: string }
  | { action: "upload"; selector: string; documentId: ID; note: string }
  | { action: "stop_for_review"; selector: string; note: string };

export interface ApplicationPlan {
  id: ID;
  familyId: ID;
  scholarshipId: ID;
  studentId: ID;
  fieldMap: Record<string, string>;
  missingFields: string[];
  documentRequests: string[];
  browserSteps: BrowserStep[];
  status: "prepared" | "blocked" | "ready_for_review";
  createdAt: string;
}

export type SubmissionSessionStatus =
  | "created"
  | "waiting_for_login"
  | "filling"
  | "waiting_for_manual_submit"
  | "submitted"
  | "blocked"
  | "failed";

export interface SubmissionSession {
  id: ID;
  familyId: ID;
  applicationPlanId: ID;
  scholarshipId: ID;
  studentId: ID;
  status: SubmissionSessionStatus;
  chromeProfile: "scholarship";
  chromeProfileLabel: string;
  launchUrl: string;
  safeMode: true;
  steps: BrowserStep[];
  blockedActions: string[];
  blockers: string[];
  reviewStop: BrowserStep;
  confirmationText?: string;
  screenshotName?: string;
  screenshotPath?: string;
  submittedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: ID;
  familyId: ID;
  actionType:
    | "account_creation"
    | "file_upload"
    | "email_send"
    | "portal_submit"
    | "signature"
    | "payment"
    | "recommendation_request"
    | "attestation";
  targetType: "scholarship" | "application_plan" | "document" | "essay";
  targetId: ID;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface AuditEvent {
  id: ID;
  familyId: ID;
  actor: "system" | "parent" | "student" | "agent";
  eventType: string;
  targetType: string;
  targetId: ID;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRun {
  id: ID;
  familyId: ID;
  runType: "weekly_pipeline" | "essay_draft" | "application_prep" | "browser_session";
  status: "running" | "completed" | "failed";
  summary: string;
  createdAt: string;
  completedAt?: string;
  output: Record<string, unknown>;
}

export type SettingsRole = "Admin" | "Employee" | "Guest" | "Viewer";

export type SettingsCapability =
  | "manageSettings"
  | "manageUsers"
  | "manageProfiles"
  | "manageScholarships"
  | "prepareApplications"
  | "approveActions"
  | "viewAudit";

export interface SettingsUser {
  id: ID;
  name: string;
  email: string;
  role: SettingsRole;
  status: "active" | "inactive";
  profileAccess: "all" | "assigned";
  profileIds: ID[];
}

export interface SettingsCustomBox {
  id: ID;
  title: string;
  content: string;
}

export interface SettingsCustomField {
  id: ID;
  label: string;
  appliesTo: "student_profile" | "scholarship" | "application" | "document" | "approval";
  type: "text" | "long_text" | "number" | "date" | "yes_no";
}

export interface SettingsCustomTab {
  id: ID;
  label: string;
  description: string;
}

export type SettingsRoleRights = Record<SettingsRole, Record<SettingsCapability, boolean>>;

export interface SettingsData {
  users: SettingsUser[];
  customBoxes: SettingsCustomBox[];
  customFields: SettingsCustomField[];
  customTabs: SettingsCustomTab[];
  roleRights: SettingsRoleRights;
  updatedAt: string;
}

export interface DashboardData {
  family: Family;
  user?: Pick<PortalUser, "id" | "email" | "displayName" | "role">;
  students: Student[];
  scholarships: Scholarship[];
  documents: DocumentRecord[];
  essayDrafts: EssayDraft[];
  applicationPlans: ApplicationPlan[];
  submissionSessions: SubmissionSession[];
  approvals: Approval[];
  auditEvents: AuditEvent[];
  agentRuns: AgentRun[];
  settings: SettingsData;
  latestInvites?: InviteSummary[];
}
