import type { ApplicationPlan, BrowserStep, DocumentRecord, Scholarship, Student } from "../types.ts";

export function prepareApplicationPlan(
  student: Student,
  scholarship: Scholarship,
  documents: DocumentRecord[]
): Omit<ApplicationPlan, "id" | "familyId" | "createdAt"> {
  const availableDocs = new Map(documents.filter((doc) => doc.studentId === student.id).map((doc) => [doc.type, doc]));
  const firstName = student.profile.firstName?.trim() || firstNameFromLegalName(student.profile.legalName || student.profile.preferredName);
  const lastName = student.profile.lastName?.trim() || lastNameFromLegalName(student.profile.legalName);
  const birthDate = dateParts(student.profile.dateOfBirth);
  const fieldMap: Record<string, string> = {
    student_name: student.profile.legalName || "",
    first_name: firstName,
    last_name: lastName,
    preferred_name: student.profile.preferredName || "",
    student_email: student.profile.email || "",
    confirmation_email: student.profile.email || "",
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
    gpa: student.profile.gpa ? String(student.profile.gpa) : "",
    intended_majors: student.profile.intendedMajors.join(", "),
    colleges_considering: (student.profile.collegesConsidering ?? []).join(", "),
    activities_summary: student.profile.activities.join("; "),
    awards: student.profile.awards.join("; "),
    street_address: student.profile.streetAddress || "",
    city: student.profile.city || "",
    postal_code: student.profile.postalCode || ""
  };
  const missingFields: string[] = [];
  const documentRequests: string[] = [];
  const requestedDocumentTypes = new Set<DocumentRecord["type"]>();

  if (!student.profile.email) {
    missingFields.push("Student email is required for scholarship submission confirmations.");
  }

  for (const requirement of scholarship.requirements) {
    if (requirement.kind === "need" && student.profile.financialNeed === "unknown") {
      missingFields.push("Financial need details require parent review.");
    }
    if (requirement.kind === "recommendation") {
      missingFields.push("Recommender name and email are required.");
      documentRequests.push("Recommendation letter or recommender request approval.");
    }
    if (requirement.kind === "attestation") {
      missingFields.push("Applicant attestation must be reviewed by the student before submission.");
    }
    if (requirement.kind === "document") {
      const requested = String(requirement.value ?? "other");
      requestedDocumentTypes.add(requested as DocumentRecord["type"]);
      const doc = availableDocs.get(requested as DocumentRecord["type"]);
      if (!doc || doc.status !== "available") {
        documentRequests.push(`${requirement.label} is ${doc?.status ?? "missing"}.`);
      }
    }
  }

  const browserSteps: BrowserStep[] = [
    { action: "navigate", url: scholarship.url, note: "Open scholarship application page." },
    ...Object.entries(fieldMap)
      .filter(([, value]) => value.trim().length > 0)
      .map(([selector, value]) => ({
        action: "fill" as const,
        selector: `[name="${selector}"]`,
        value,
        source: "student_profile",
        label: fieldStepLabel(selector),
        aliases: fieldSelectorAliases(selector)
      })),
    ...documents
      .filter((doc) => doc.studentId === student.id && doc.status === "available")
      .filter((doc) => requestedDocumentTypes.has(doc.type))
      .map((doc) => ({
        action: "upload" as const,
        selector: `[data-document="${doc.type}"]`,
        documentId: doc.id,
        note: `Stage ${doc.name}; requires approval before upload.`
      })),
    {
      action: "stop_for_review" as const,
      selector: `button[type="submit"], input[type="submit"]`,
      note: "Stop before any submit, signature, payment, recommendation request, or attestation action."
    }
  ];

  return {
    scholarshipId: scholarship.id,
    studentId: student.id,
    fieldMap,
    missingFields,
    documentRequests,
    browserSteps,
    status: missingFields.length > 0 || documentRequests.length > 0 ? "prepared" : "ready_for_review"
  };
}

function firstNameFromLegalName(name: string): string {
  return String(name || "").trim().split(/\s+/)[0] ?? "";
}

function lastNameFromLegalName(name: string): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

function dateParts(rawDate: string | undefined): { month: string; day: string; year: string } {
  const match = String(rawDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { month: "", day: "", year: "" };
  const monthIndex = Number(match[2]) - 1;
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
  ][monthIndex] ?? "";
  return { month, day: String(Number(match[3])), year: match[1] };
}

function fieldSelectorAliases(field: string): string[] {
  const aliases: Record<string, string[]> = {
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

function fieldStepLabel(field: string): string {
  const labels: Record<string, string> = {
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

export function assertNoSubmitSteps(steps: BrowserStep[]): void {
  const unsafe = steps.find((step) => {
    if (step.action === "stop_for_review" || step.action === "navigate") return false;
    return /button\[type="submit"\]|input\[type="submit"\]|click submit|final submit/i.test(JSON.stringify(step));
  });
  if (unsafe) {
    throw new Error(`Unsafe browser step attempted to submit: ${JSON.stringify(unsafe)}`);
  }
}
