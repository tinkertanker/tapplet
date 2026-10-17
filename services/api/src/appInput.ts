import type { TeacherBrief } from "./ai/provider";
import { HttpError } from "./http";
import type { ArtifactRecord } from "./storage/repository";

// Request-body parsing and validation for the studio API routes.
export const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const SLUG = /^[A-Za-z0-9_-]{16,64}$/;
export const REASONS = new Set([
  "inappropriate",
  "personal-data",
  "copyright",
  "accessibility",
  "other",
]);
export function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new HttpError(400, "INVALID_BODY", "Body must be a JSON object.");
  return v as Record<string, unknown>;
}
export function str(v: unknown, n: string, max: number) {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    throw new HttpError(422, "INVALID_INPUT", `${n} is required or too long.`);
  return v.trim();
}
export function optionalStr(v: unknown, n: string, max: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return str(v, n, max);
}
export function days(d: Date, n: number) {
  return new Date(d.getTime() + n * 86400000).toISOString();
}
export function retrievalQuery(value: string): string | null {
  const terms = value
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, 12);
  return terms?.length
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
    : null;
}
const ACTIVITY_FORMS = ["game", "quiz", "simulation", "practice"] as const;
type ActivityForm = (typeof ACTIVITY_FORMS)[number];
function optionalForm(value: unknown): ActivityForm | undefined {
  const raw = optionalStr(value, "Activity form", 20);
  if (!raw) return undefined;
  const form = raw.toLowerCase();
  if (!ACTIVITY_FORMS.includes(form as ActivityForm))
    throw new HttpError(
      422,
      "INVALID_INPUT",
      "Activity form must be game, quiz, simulation or practice.",
    );
  return form as ActivityForm;
}
// BCP 47-shaped tags such as en-SG, fr or zh-Hans-SG; sent to the model as part of the brief.
function optionalLocale(value: unknown): string | undefined {
  const locale = optionalStr(value, "Locale", 30);
  if (locale && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale))
    throw new HttpError(422, "INVALID_INPUT", "Locale must be a language tag such as en-SG.");
  return locale;
}
function inferSubject(learnerContext: string): string {
  const text = learnerContext.toLowerCase();
  if (/\bmaths?\b|\bmathematics\b|\balgebra\b/.test(text)) return "mathematics";
  if (
    /\bsci(?:ence)?\b|\bphy(?:sics)?\b|\bchem(?:istry)?\b|\bbio(?:logy)?\b/.test(
      text,
    )
  )
    return "science";
  if (/\benglish\b|\blit(?:erature)?\b|\bliteracy\b|\bspelling\b/.test(text))
    return "english";
  if (/\bhumanities\b|\bgeog(?:raphy)?\b|\bhist(?:ory)?\b/.test(text))
    return "humanities";
  if (/\bcivics\b|\bcitizenship\b|\bsocial studies\b/.test(text)) return "civics";
  if (
    /\b(?:chinese|malay|tamil|mother tongue|mtl|higher chinese|higher malay|higher tamil)\b/.test(
      text,
    )
  )
    return "languages";
  return "other";
}
export function generationRetrievalQuery(brief: TeacherBrief): string | null {
  return retrievalQuery(
    [brief.format, brief.learnerContext ?? `${brief.level} ${brief.subject}`, brief.learningObjective]
      .filter(Boolean)
      .join(" "),
  );
}
export function stringList(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new HttpError(422, "INVALID_INPUT", `${name} must be a short list.`);
  return value.map((entry) => str(entry, name, 60));
}
interface GuidedGeneration {
  creationBrief: string;
  brief: TeacherBrief;
  preferredExampleRevisionId: string | null;
}
export function brief(b: Record<string, unknown>): GuidedGeneration {
  const guided = obj(b.brief);
  const learnerContext = str(guided.learnerContext, "Learner context", 300);
  const format = optionalForm(guided.format);
  const sourceContent = optionalStr(guided.sourceContent, "Source content", 4000);
  const locale = optionalLocale(guided.locale);
  return {
    // Studio joins every answer (up to 7,500 characters) with its question.
    creationBrief: str(b.creationBrief, "Creation brief", 8000),
    preferredExampleRevisionId:
      b.preferredExampleRevisionId == null
        ? null
        : str(b.preferredExampleRevisionId, "Preferred example revision", 100),
    brief: {
      level: learnerContext,
      subject: inferSubject(learnerContext),
      learnerContext,
      learningObjective: str(
        guided.learningObjective,
        "Learning objective",
        600,
      ),
      studentAction: str(guided.studentAction, "Student action", 600),
      ...(sourceContent ? { content: sourceContent, sourceContent } : {}),
      feedback: str(guided.feedback, "Feedback", 1000),
      classroomFit: str(guided.classroomFit, "Classroom fit", 1000),
      ...(format ? { format } : {}),
      ...(locale ? { locale } : {}),
    },
  };
}
export function remixBrief(source: ArtifactRecord): TeacherBrief {
  return {
    level: source.level ?? "General",
    subject: source.subject ?? "General",
    learnerContext: `${source.level ?? "General"} ${source.subject ?? "General"}`
      .trim()
      .slice(0, 300),
    learningObjective: (source.learningObjective ?? source.title).slice(
      0,
      600,
    ),
    studentAction: source.summary.slice(0, 600),
    feedback: "Ask the teacher for feedback on this remixed tapplet.",
    classroomFit: source.level ?? "Classroom use",
    ...(source.locale ? { locale: source.locale } : {}),
  };
}
