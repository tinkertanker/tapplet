import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

const origin = (
  process.env.STUDIO_LIVE_ORIGIN ??
  "https://classroom-widgets-studio-api.tinkertanker.workers.dev"
).replace(/\/$/, "");
const root = resolve(import.meta.dirname, "..");
// Never migrate the old shared-temporary-directory state: it is untrusted.
const stateDirectory = resolve(homedir(), ".tapplet-publication-browser-fixture");
const statePath = resolve(stateDirectory, "state.json");
const action = process.argv[2];

interface FixtureState {
  origin: string;
  artifactId: string;
  slug: string;
  url: string;
}

async function openState(create: boolean): Promise<FileHandle> {
  if (create) await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDirectory);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) {
    throw new Error("Fixture state directory must be owned by this user with mode 0700.");
  }
  const file = await open(statePath,
    constants.O_NOFOLLOW | constants.O_NONBLOCK | (create
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      : constants.O_RDONLY),
    0o600);
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
    await file.close();
    throw new Error("Fixture state must be a private, owned regular file with mode 0600.");
  }
  return file;
}

async function authenticated(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = (
    await readFile(resolve(root, ".studio-smoke-token"), "utf8")
  ).trim();
  return fetch(`${origin}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Device-Token": token,
      ...init.headers,
    },
  });
}

async function expectJson(
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await authenticated(path, init);
  const body = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    body === undefined ||
    body === null ||
    typeof body !== "object"
  ) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body as Record<string, unknown>;
}

async function expectSuccess(path: string, init: RequestInit): Promise<void> {
  const response = await authenticated(path, init);
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path} failed with ${response.status}.`,
    );
}

async function prepare(stateFile: FileHandle): Promise<void> {
  const manifest = JSON.parse(
    await readFile(
      resolve(root, "apps/ipad/Resources/Examples/manifest.json"),
      "utf8",
    ),
  ) as { seeds?: Array<{ id?: unknown }> };
  const seedId = manifest.seeds?.find(
    (seed): seed is { id: string } => typeof seed.id === "string",
  )?.id;
  if (!seedId)
    throw new Error(
      "The canonical example manifest is empty; curate seeds before preparing the fixture.",
    );
  const remixed = await expectJson(
    `/v1/revisions/${encodeURIComponent(`${seedId}-seed`)}/remix`,
    {
      method: "POST",
      body: JSON.stringify({ title: "Publication browser fixture" }),
    },
  );
  const artifact = remixed.artifact as { id?: unknown } | undefined;
  const headRevision = remixed.headRevision as { id?: unknown } | undefined;
  if (
    typeof artifact?.id !== "string" ||
    typeof headRevision?.id !== "string"
  ) {
    throw new Error(
      "Tapplet did not return a remixed artifact. Import the curated seeds before preparing the fixture.",
    );
  }

  try {
    const published = await expectJson(
      `/v1/artifacts/${encodeURIComponent(artifact.id)}/publish`,
      {
        method: "POST",
        body: JSON.stringify({ expectedHeadRevisionId: headRevision.id }),
      },
    );
    const publication = published.publication as
      { slug?: unknown; url?: unknown } | undefined;
    if (
      typeof publication?.slug !== "string" ||
      typeof publication.url !== "string"
    ) {
      throw new Error("Tapplet did not return a publication URL.");
    }
    const state: FixtureState = {
      origin,
      artifactId: artifact.id,
      slug: publication.slug,
      url: publication.url,
    };
    await stateFile.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    console.log(state.url);
  } catch (error) {
    await expectSuccess(`/v1/artifacts/${encodeURIComponent(artifact.id)}`, {
      method: "DELETE",
    });
    throw error;
  }
}

async function cleanup(): Promise<void> {
  const file = await openState(false);
  let state: FixtureState;
  try {
    state = JSON.parse(await file.readFile("utf8")) as FixtureState;
  } finally {
    await file.close();
  }
  if (state?.origin !== origin || typeof state.artifactId !== "string" || !state.artifactId || typeof state.slug !== "string" || !state.slug) {
    throw new Error("Fixture state is invalid or belongs to a different API origin.");
  }
  await expectSuccess(`/v1/publications/${encodeURIComponent(state.slug)}`, {
    method: "DELETE",
  });
  await expectSuccess(`/v1/artifacts/${encodeURIComponent(state.artifactId)}`, {
    method: "DELETE",
  });
  await unlink(statePath);
  console.log("Browser fixture revoked and deleted.");
}

async function main(): Promise<void> {
  if (action === "prepare") {
    // Reserve state before creating any remote resources; do not overwrite a fixture.
    const file = await openState(true);
    try {
      await prepare(file);
    } catch (error) {
      await unlink(statePath);
      throw error;
    } finally {
      await file.close();
    }
  }
  else if (action === "cleanup") await cleanup();
  else
    throw new Error(
      "Usage: tsx scripts/publication-browser-fixture.ts prepare|cleanup",
    );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
