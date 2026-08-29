export interface ArtifactEvaluationRequest {
  locale?: string;
  expectedInteractions?: string[];
  contentTerms?: string[];
}

export interface ArtifactEvaluation {
  valid: boolean;
  artifact?: { html: string; designCard?: Record<string, unknown> };
  checks: Array<{ kind: string; requested: string; passed: boolean }>;
  issues: Array<{ code: string; message: string }>;
}

export function parseProviderArtifact(output: unknown): {
  html: string;
  designCard?: Record<string, unknown>;
};

export function assessArtifact(
  output: unknown,
  request?: ArtifactEvaluationRequest,
): ArtifactEvaluation;
