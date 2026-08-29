import type { StudentProfile } from "./types.ts";

export function sampleStudentProfile(): StudentProfile {
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
      challenge:
        "I used to avoid speaking in meetings, then practiced leading short standups for robotics until presenting felt normal.",
      futureGoal:
        "I want to study technology and policy so I can build public tools that are practical for families who do not have time to decode complex systems.",
      voiceNotes: "Direct, warm, specific, not overly polished."
    }
  };
}
