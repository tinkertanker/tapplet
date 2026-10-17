import type {
  DesignCard,
  Exemplar,
  GeneratedArtifact,
  ModelProvider,
  ModerationDecision,
  TeacherBrief,
} from "./provider";
import { escapeHtml } from "../generation";

function page(title: string, detail: string) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safeTitle}</title><style>body{font-family:system-ui;max-width:48rem;margin:3rem auto;padding:1rem}button{padding:.7rem}</style></head><body><main><h1>${safeTitle}</h1><p>${escapeHtml(detail)}</p><button onclick="this.textContent='Well done'">Check</button></main></body></html>`;
}
export class FixtureModelProvider implements ModelProvider {
  readonly name = "fixture";
  async generate(b: TeacherBrief, _e: Exemplar[]): Promise<GeneratedArtifact> {
    return {
      html: page(b.learningObjective, b.studentAction),
      designCard: { title: b.learningObjective, description: b.subject },
      comment: "Made a first version from your plan.",
    };
  }
  async revise(
    _h: string,
    c: DesignCard | undefined,
    i: string,
    _b: TeacherBrief,
  ): Promise<GeneratedArtifact> {
    return {
      html: page(c?.title ?? "Classroom applet", i),
      designCard: c,
      comment: `Applied your change: ${i}`,
    };
  }
  async repair(candidate: unknown) {
    return candidate;
  }
  async moderate(): Promise<ModerationDecision> {
    return { safe: true, categories: [] };
  }
}
