import type { OperationalTraceContext } from "../operationalTrace";

export interface TeacherBrief {
  level: string;
  subject: string;
  learningObjective: string;
  studentAction: string;
  content?: string;
  feedback?: string;
  durationMinutes?: number;
  accessibilityNeeds?: string;
  learnerContext?: string;
  sourceContent?: string;
  classroomFit?: string;
  format?: "game" | "quiz" | "simulation" | "practice";
  locale?: string;
}
export interface DesignCard {
  title?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}
export interface Exemplar {
  revisionId: string;
  html: string;
  designCard?: DesignCard;
  descriptor: string;
}
export interface GeneratedArtifact {
  html: string;
  designCard?: DesignCard;
}
export interface ModerationDecision {
  safe: boolean;
  categories: string[];
  reason?: string;
}
export interface RepairContext {
  brief: TeacherBrief;
  instruction?: string;
  final?: boolean;
}
export interface ModelProvider {
  readonly name: string;
  // Session IDs are opaque conversation identifiers, never device tokens or owner data.
  generate(
    brief: TeacherBrief,
    exemplars: Exemplar[],
    trace?: OperationalTraceContext,
    sessionId?: string,
  ): Promise<unknown>;
  revise(
    currentHtml: string,
    designCard: DesignCard | undefined,
    instruction: string,
    brief: TeacherBrief,
    trace?: OperationalTraceContext,
    sessionId?: string,
  ): Promise<unknown>;
  repair(
    candidate: unknown,
    issues: string[],
    context?: RepairContext,
    trace?: OperationalTraceContext,
    sessionId?: string,
  ): Promise<unknown>;
  moderate(
    html: string,
    trace?: OperationalTraceContext,
    sessionId?: string,
  ): Promise<ModerationDecision>;
}
// Each direct model call aborts after this long. A generation makes up to three
// calls, so repairs are bounded by MODEL_WORK_BUDGET_MS in generation.ts.
export const MODEL_CALL_TIMEOUT_MS = 60_000;

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
