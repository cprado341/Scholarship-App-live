import type { Family, FamilyMember, ID, SaaSRole, SettingsCapability, Student } from "../types.ts";

export interface ClerkWorkspaceIdentity {
  clerkUserId: string;
  clerkOrgId: string;
  email: string;
  organizationName: string;
}

export interface WorkspaceContext {
  family: Family;
  member: FamilyMember;
  role: SaaSRole;
  allowedProfileIds: ID[];
}

export function isPlatformAdmin(email: string, configured = process.env.PLATFORM_ADMIN_EMAILS ?? ""): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return configured
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

export function normalizeClerkRole(role: string | undefined): SaaSRole {
  if (role === "Admin" || role === "Contributor" || role === "Guest" || role === "Viewer") return role;
  if (role === "org:admin" || role === "admin") return "Admin";
  if (role === "org:member" || role === "member") return "Contributor";
  return "Viewer";
}

export function profileAccessForMember(member: FamilyMember, students: Student[]): ID[] {
  if (member.role === "Admin") return students.map((student) => student.id);
  const available = new Set(students.map((student) => student.id));
  return member.profileIds.filter((id) => available.has(id));
}

export function canUseCapability(member: FamilyMember, capability: SettingsCapability): boolean {
  if (member.role === "Admin") return true;
  if (capability === "manageSettings" || capability === "manageUsers" || capability === "approveActions") return false;
  if (member.role === "Contributor") {
    return capability === "manageProfiles" || capability === "manageScholarships" || capability === "prepareApplications";
  }
  if (member.role === "Viewer") return capability === "viewAudit";
  return false;
}

export function assertProfileAssignment(member: FamilyMember): void {
  if (member.role !== "Admin" && member.profileIds.length === 0) {
    throw new Error("Non-admin members must be assigned to at least one Profile.");
  }
}
