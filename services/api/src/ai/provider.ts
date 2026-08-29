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
  generate(
    brief: TeacherBrief,
    exemplars: Exemplar[],
    trace?: OperationalTraceContext,
  ): Promise<unknown>;
  revise(
    currentHtml: string,
    designCard: DesignCard | undefined,
    instruction: string,
    brief: TeacherBrief,
    trace?: OperationalTraceContext,
  ): Promise<unknown>;
  repair(
    candidate: unknown,
    issues: string[],
    context?: RepairContext,
    trace?: OperationalTraceContext,
  ): Promise<unknown>;
  moderate(
    html: string,
    trace?: OperationalTraceContext,
  ): Promise<ModerationDecision>;
}
export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
