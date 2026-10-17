import { loadValidatedSeeds } from "../../scripts/lib/seed-corpus.mjs";

async function main(): Promise<void> {
  const { manifest } = await loadValidatedSeeds();
  const subjects = new Set(
    manifest.seeds.map((seed: { subject: string }) => seed.subject),
  );
  const levels = new Set(
    manifest.seeds.map((seed: { level: string }) => seed.level),
  );
  if (
    !["science", "mathematics", "english", "humanities"].every((subject) =>
      subjects.has(subject),
    )
  )
    throw new Error("Core subject coverage is incomplete.");
  if (!["upper-primary", "secondary"].every((level) => levels.has(level)))
    throw new Error("Level coverage is incomplete.");
  console.log(
    `HTML artifact corpus evaluation passed: ${manifest.seeds.length} seeds, ${subjects.size} subjects, ${levels.size} levels.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
