import type { EssayDraft, Scholarship, Student } from "../types.ts";

const forbiddenUnsupportedClaims = [
  /single[- ]parent household/i,
  /family income/i,
  /diagnosed/i,
  /immigration status/i,
  /captain of/i,
  /national champion/i
];

export function draftEssayFromInterview(student: Student, scholarship: Scholarship): Omit<EssayDraft, "id" | "familyId" | "updatedAt"> {
  const interview = student.profile.essayInterview;
  const prompt = essayPromptFor(scholarship);
  const maxWords = scholarship.requirements.find((requirement) => requirement.kind === "essay")?.value ?? 500;
  const draft = [
    `Prompt: ${prompt}`,
    "",
    `${student.profile.preferredName}'s story starts with a practical kind of leadership: noticing where a process is confusing and making it easier for other people to join in.`,
    `In robotics, ${student.profile.preferredName} ${interview.proudMoment.charAt(0).toLowerCase()}${interview.proudMoment.slice(1)}`,
    `That same instinct showed up outside school. ${interview.communityImpact}`,
    `The growth was not automatic. ${interview.challenge}`,
    `Looking ahead, ${student.profile.preferredName} ${interview.futureGoal.charAt(0).toLowerCase()}${interview.futureGoal.slice(1)}`,
    `For this scholarship, the strongest fit is the connection between service, technology, and steady follow-through. The draft should stay ${interview.voiceNotes.toLowerCase()}`
  ].join("\n\n");

  return {
    studentId: student.id,
    scholarshipId: scholarship.id,
    prompt: `${prompt} Target length: up to ${maxWords} words.`,
    interview,
    draft,
    unsupportedClaims: findUnsupportedClaims(draft),
    status: "needs_student_review"
  };
}

export function findUnsupportedClaims(text: string): string[] {
  return forbiddenUnsupportedClaims
    .filter((pattern) => pattern.test(text))
    .map((pattern) => `Potential unsupported claim matched ${pattern.source}`);
}

export function essayPromptFor(scholarship: Scholarship): string {
  if (scholarship.tags.includes("service")) return "Describe how your service or leadership has affected your community.";
  if (scholarship.tags.includes("stem")) return "Describe your interest in STEM and how you hope to use it.";
  if (scholarship.tags.includes("first-generation")) return "Describe your goals and the support systems that helped shape them.";
  return "Describe your goals, experiences, and why you are a strong applicant.";
}
