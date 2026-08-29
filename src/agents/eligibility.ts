import type { DiscoveredScholarship, EffortLevel, Scholarship, Student } from "../types.ts";

export interface EligibilityResult {
  fitScore: number;
  effort: EffortLevel;
  rationale: string[];
  risks: string[];
}

export function scoreScholarship(student: Student, scholarship: DiscoveredScholarship | Scholarship): EligibilityResult {
  const profile = student.profile;
  let score = 45;
  const rationale: string[] = [];
  const risks = [...scholarship.risks];
  let effortPoints = 0;

  for (const requirement of scholarship.requirements) {
    switch (requirement.kind) {
      case "grade":
        if (profile.gradeLevel === "junior" || profile.gradeLevel === "senior") {
          score += 12;
          rationale.push("Grade level matches.");
        }
        break;
      case "gpa":
        if (typeof profile.gpa === "number" && profile.gpa >= Number(requirement.value)) {
          score += 12;
          rationale.push(`GPA ${profile.gpa.toFixed(1)} meets the minimum.`);
        } else {
          score -= requirement.required ? 20 : 4;
          risks.push("GPA is missing or below the listed minimum.");
        }
        break;
      case "citizenship":
        if (profile.citizenship === "us_citizen" || profile.citizenship === "permanent_resident") {
          score += 8;
          rationale.push("Citizenship requirement appears satisfied.");
        } else {
          score -= requirement.required ? 18 : 4;
          risks.push("Citizenship eligibility needs review.");
        }
        break;
      case "location":
        if (String(requirement.value).toUpperCase() === profile.schoolState.toUpperCase()) {
          score += 14;
          rationale.push("Location matches the student profile.");
        } else {
          score -= requirement.required ? 18 : 3;
          risks.push("Location eligibility may not match.");
        }
        break;
      case "major": {
        const value = String(requirement.value ?? "").toLowerCase();
        const majorMatch = profile.intendedMajors.some((major) => {
          const normalized = major.toLowerCase();
          return normalized.includes(value) || (value === "stem" && /science|engineering|math|technology|computer/.test(normalized));
        });
        if (majorMatch) {
          score += 14;
          rationale.push("Intended major lines up with the scholarship focus.");
        } else {
          score -= requirement.required ? 16 : 4;
          risks.push("Major requirement needs review.");
        }
        break;
      }
      case "service":
        if ((profile.serviceHours ?? 0) > 0 || profile.activities.some((activity) => /volunteer|service|food bank/i.test(activity))) {
          score += 10;
          rationale.push("Service experience is present.");
        } else {
          score -= requirement.required ? 14 : 3;
          risks.push("Service requirement may be unsupported.");
        }
        break;
      case "need":
        if (profile.financialNeed === "yes") score += 8;
        if (profile.financialNeed === "unknown") {
          risks.push("Financial need question requires parent review.");
          score -= 2;
        }
        break;
      case "essay":
        effortPoints += Number(requirement.value ?? 500) > 500 ? 2 : 1;
        score += 4;
        break;
      case "document":
        effortPoints += 1;
        break;
      case "recommendation":
        effortPoints += 3;
        risks.push("Recommendation request needs approval.");
        break;
      case "attestation":
        effortPoints += 1;
        risks.push("Attestation language must be reviewed before submission.");
        break;
    }
  }

  const effort: EffortLevel = effortPoints <= 2 ? "low" : effortPoints <= 5 ? "medium" : "high";
  if (effort === "high") score -= 4;
  return {
    fitScore: Math.max(0, Math.min(100, score)),
    effort,
    rationale,
    risks: [...new Set(risks)]
  };
}

export function dedupeScholarships<T extends { url: string; title: string }>(scholarships: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const scholarship of scholarships) {
    const key = scholarship.url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(scholarship);
  }
  return result;
}

export function scholarshipRequiresEssay(scholarship: Pick<DiscoveredScholarship | Scholarship, "requirements">): boolean {
  return scholarship.requirements.some((requirement) => requirement.kind === "essay");
}

export function filterNoEssayScholarships<T extends Pick<DiscoveredScholarship | Scholarship, "requirements">>(scholarships: T[]): T[] {
  return scholarships.filter((scholarship) => !scholarshipRequiresEssay(scholarship));
}
