import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateHtmlArtifact } from "./lib/html-artifact.mjs";
import {
  liveImageFixture,
  readLiveImageFixture,
} from "./lib/live-image-fixture.mjs";

const origin = (
  process.env.STUDIO_LIVE_ORIGIN ??
  "https://classroom-widgets-studio-api.tinkertanker.workers.dev"
).replace(/\/$/, "");
const tokenPath = resolve(".studio-smoke-token");
const smokeCodePath = resolve(".studio-class-codes/0000.txt");
const explicitAccessCode = process.env.STUDIO_CLASS_ACCESS_CODE?.trim();
let token =
  process.env.STUDIO_DEVICE_TOKEN?.trim() ||
  (!explicitAccessCode && existsSync(tokenPath)
    ? readFileSync(tokenPath, "utf8").trim()
    : "");
let registrationAccessCode: string | undefined;
const jsonHeaders: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

interface ArtifactEnvelope {
  artifact: { id: string; headRevisionId: string };
  headRevision: { id: string; parentRevisionId?: string | null };
  html: string;
  warnings?: AdvisoryWarning[];
}

interface AdvisoryWarning {
  source: string;
  code: string;
  message: string;
  categories?: string[];
}

const advisoryTestMarker = "advisory-check@example.com";
const advisoryWarningSources = new Set([
  "prompt",
  "generated_content",
  "publication",
  "image",
]);
const advisoryWarningCodes = new Set([
  "POSSIBLE_EMAIL",
  "POSSIBLE_PHONE",
  "POSSIBLE_STUDENT_IDENTIFIER",
  "UNSAFE_HARM_INSTRUCTION",
  "SEXUAL_CONTENT_INVOLVING_MINORS",
  "AI_CONTENT_REVIEW_FLAGGED",
  "AI_CONTENT_REVIEW_UNAVAILABLE",
  "AI_IMAGE_REVIEW_FLAGGED",
  "AI_IMAGE_REVIEW_UNAVAILABLE",
]);

async function ensureDeviceToken(): Promise<void> {
  if (token) {
    jsonHeaders["X-Device-Token"] = token;
    return;
  }
  const localSmokeCode = existsSync(smokeCodePath)
    ? /^(\d{4}[A-Z]{8})$/m.exec(readFileSync(smokeCodePath, "utf8"))?.[1]
    : undefined;
  const accessCode = explicitAccessCode || localSmokeCode;
  if (!accessCode) {
    throw new Error(
      "Set STUDIO_CLASS_ACCESS_CODE for the first live verification, provision class 0000, or restore .studio-smoke-token.",
    );
  }
  registrationAccessCode = accessCode;
  const response = await fetch(`${origin}/v1/devices/register`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode }),
  });
  const body = (await response.json().catch(() => undefined)) as
    { token?: string } | { error?: { message?: string } } | undefined;
  if (!response.ok || !body || !("token" in body) || !body.token) {
    const message = body && "error" in body ? body.error?.message : undefined;
    throw new Error(
      `Device registration failed (${response.status}): ${message ?? "unknown error"}`,
    );
  }
  token = body.token;
  jsonHeaders["X-Device-Token"] = token;
  writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

async function jsonRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...init.headers },
  });
  const body =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function artifactEnvelope(body: unknown, operation: string): ArtifactEnvelope {
  const envelope = body as Partial<ArtifactEnvelope> | undefined;
  if (
    typeof envelope?.artifact?.id !== "string" ||
    typeof envelope.headRevision?.id !== "string" ||
    typeof envelope.html !== "string"
  ) {
    throw new Error(
      `${operation} did not return a complete artifact envelope.`,
    );
  }
  const validation = validateHtmlArtifact(envelope.html);
  if (!validation.valid) {
    throw new Error(
      `${operation} returned invalid HTML: ${validation.issues
        .map((issue: { message: string }) => issue.message)
        .join("; ")}`,
    );
  }
  validateWarnings(envelope, operation);
  return envelope as ArtifactEnvelope;
}

function validateWarnings(body: unknown, operation: string): AdvisoryWarning[] {
  const warnings = (body as { warnings?: unknown } | undefined)?.warnings;
  if (warnings === undefined) return [];
  if (!Array.isArray(warnings) || warnings.length > 20) {
    throw new Error(`${operation} returned an invalid advisory warning.`);
  }
  for (const warning of warnings) {
    if (!warning || typeof warning !== "object") {
      throw new Error(`${operation} returned an invalid advisory warning.`);
    }
    const source = Reflect.get(warning, "source");
    const code = Reflect.get(warning, "code");
    const message = Reflect.get(warning, "message");
    const categories = Reflect.get(warning, "categories");
    if (
      Object.keys(warning).some(
        (key) => !["source", "code", "message", "categories"].includes(key),
      ) ||
      typeof source !== "string" ||
      !advisoryWarningSources.has(source) ||
      typeof code !== "string" ||
      !advisoryWarningCodes.has(code) ||
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > 600 ||
      (categories !== undefined &&
        (!Array.isArray(categories) ||
          categories.length > 10 ||
          categories.some(
            (category) =>
              typeof category !== "string" ||
              category.trim().length === 0 ||
              category.length > 100,
          )))
    ) {
      throw new Error(`${operation} returned an invalid advisory warning.`);
    }
  }
  const serialised = JSON.stringify(warnings).toLowerCase();
  for (const privateValue of [
    advisoryTestMarker,
    token,
    explicitAccessCode,
    registrationAccessCode,
  ]) {
    if (privateValue && serialised.includes(privateValue.toLowerCase())) {
      throw new Error(`${operation} echoed private input in an advisory warning.`);
    }
  }
  return warnings as AdvisoryWarning[];
}

async function main() {
  await ensureDeviceToken();
  let artifactId: string | undefined;
  let slug: string | undefined;
  let assetId: string | undefined;
  try {
    const health = await fetch(`${origin}/health`);
    if (!health.ok)
      throw new Error(`Health check failed with ${health.status}.`);

    const examples = (await jsonRequest(
      "/v1/examples/search?q=science&limit=5",
    )) as {
      examples?: Array<{ revisionId?: string; curated?: boolean }>;
    };
    const preferredExampleRevisionId = examples.examples?.find(
      (example) => example.curated,
    )?.revisionId;
    if (!preferredExampleRevisionId) {
      throw new Error(
        "No curated example was retrievable. Import the Tapplet seed corpus before running live verification.",
      );
    }

    const generatedBody = await jsonRequest("/v1/artifacts/generate", {
      method: "POST",
      body: JSON.stringify({
        creationBrief:
          "Create a concise Secondary 2 activity about balanced and unbalanced forces.",
        brief: {
          learnerContext: "Secondary 2 Science",
          learningObjective:
            "Distinguish balanced and unbalanced forces in familiar situations.",
          studentAction:
            "Classify situations and read immediate explanatory feedback.",
          feedback: "Explain the resultant force after each answer.",
          classroomFit: "Six minutes of independent practice.",
        },
        preferredExampleRevisionId,
      }),
    });
    const generatedArtifactId = (
      generatedBody as Partial<ArtifactEnvelope> | undefined
    )?.artifact?.id;
    if (
      typeof generatedArtifactId === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(generatedArtifactId)
    ) {
      artifactId = generatedArtifactId;
    }
    const generated = artifactEnvelope(generatedBody, "Generation");
    artifactId = generated.artifact.id;

    const revised = artifactEnvelope(
      await jsonRequest(
        `/v1/artifacts/${encodeURIComponent(artifactId)}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            instruction: `Make the student instructions more concise. Do not include the fictional verification marker ${advisoryTestMarker} in the tapplet.`,
            expectedHeadRevisionId: generated.headRevision.id,
          }),
        },
      ),
      "Revision",
    );
    if (revised.headRevision.parentRevisionId !== generated.headRevision.id) {
      throw new Error("Revision did not preserve parent history.");
    }
    if (
      !revised.warnings?.some(
        (warning) =>
          warning.source === "prompt" && warning.code === "POSSIBLE_EMAIL",
      )
    ) {
      throw new Error(
        "Revision did not return the expected warning-only prompt advisory.",
      );
    }

    const restored = artifactEnvelope(
      await jsonRequest(`/v1/artifacts/${encodeURIComponent(artifactId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          headRevisionId: generated.headRevision.id,
          expectedHeadRevisionId: revised.headRevision.id,
        }),
      }),
      "History restore",
    );
    if (restored.html !== generated.html)
      throw new Error("History restore did not recover the original source.");

    const returnedToLatest = artifactEnvelope(
      await jsonRequest(`/v1/artifacts/${encodeURIComponent(artifactId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          headRevisionId: revised.headRevision.id,
          expectedHeadRevisionId: restored.headRevision.id,
        }),
      }),
      "Head restore",
    );

    const imageBytes = readLiveImageFixture();
    const uploadedImage = await fetch(`${origin}/v1/assets`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": liveImageFixture.mediaType,
        "X-Device-Token": token,
        "X-Image-Width": String(liveImageFixture.width),
        "X-Image-Height": String(liveImageFixture.height),
        "X-Image-Sha256": createHash("sha256").update(imageBytes).digest("hex"),
        "X-Image-Alt-Base64": Buffer.from(liveImageFixture.alternativeText).toString(
          "base64",
        ),
        "X-Image-Decorative": "false",
      },
      body: Uint8Array.from(imageBytes),
    });
    const uploadedBody = (await uploadedImage.json().catch(() => undefined)) as
      | {
          asset?: { id?: string; mediaType?: string; sha256?: string };
          warnings?: AdvisoryWarning[];
        }
      | undefined;
    if (!uploadedImage.ok || typeof uploadedBody?.asset?.id !== "string") {
      throw new Error(
        `Live image upload failed (${uploadedImage.status}): ${JSON.stringify(uploadedBody)}`,
      );
    }
    validateWarnings(uploadedBody, "Image upload");
    assetId = uploadedBody.asset.id;

    const withImage = artifactEnvelope(
      await jsonRequest(
        `/v1/artifacts/${encodeURIComponent(artifactId)}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            instruction: `Add the uploaded image using the exact relative URL assets/${assetId}. Give it the alternative text “${liveImageFixture.alternativeText}”`,
            requiredAssetId: assetId,
            expectedHeadRevisionId: returnedToLatest.headRevision.id,
          }),
        },
      ),
      "Image revision",
    );
    if (!withImage.html.includes(`assets/${assetId}`)) {
      throw new Error(
        "Image revision did not reference the uploaded managed image.",
      );
    }

    const published = (await jsonRequest(
      `/v1/artifacts/${encodeURIComponent(artifactId)}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedHeadRevisionId: withImage.headRevision.id,
        }),
      },
    )) as {
      publication?: { slug?: string; url?: string; expiresAt?: string };
      warnings?: AdvisoryWarning[];
    };
    if (
      typeof published.publication?.slug !== "string" ||
      typeof published.publication.url !== "string" ||
      typeof published.publication.expiresAt !== "string"
    ) {
      throw new Error("Publish did not return a complete publication.");
    }
    validateWarnings(published, "Publish");
    slug = published.publication.slug;
    const publicUrl = published.publication.url;

    const extended = (await jsonRequest(
      `/v1/publications/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ days: 30 }),
      },
    )) as { publication?: { slug?: string; expiresAt?: string } };
    if (
      extended.publication?.slug !== slug ||
      Date.parse(String(extended.publication.expiresAt)) <=
        Date.parse(published.publication.expiresAt)
    ) {
      throw new Error(
        "Publication extension did not preserve the slug and move expiry forward.",
      );
    }

    const publicPage = await fetch(publicUrl, {
      headers: { Accept: "text/html" },
    });
    const publicHtml = await publicPage.text();
    if (
      !publicPage.ok ||
      !publicHtml.includes("data-studio-report") ||
      !publicHtml.includes(`/${slug}/`)
    ) {
      throw new Error(
        "Published student HTML did not load with its fixed service controls.",
      );
    }
    const publicImage = await fetch(
      `${origin}/${encodeURIComponent(slug)}/assets/${encodeURIComponent(assetId)}`,
    );
    const publicImageBytes = Buffer.from(await publicImage.arrayBuffer());
    if (
      !publicImage.ok ||
      publicImage.headers.get("content-type") !== uploadedBody.asset.mediaType ||
      createHash("sha256").update(publicImageBytes).digest("hex") !==
        uploadedBody.asset.sha256
    ) {
      throw new Error(
        "Published image could not be loaded intact without credentials.",
      );
    }
    const report = await fetch(
      `${origin}/v1/publications/${encodeURIComponent(slug)}/reports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "other" }),
      },
    );
    if (report.status !== 204)
      throw new Error(`Publication report returned ${report.status}.`);

    await jsonRequest(`/v1/publications/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    const revoked = await fetch(publicUrl, {
      headers: { Accept: "text/html" },
    });
    if (revoked.status !== 410)
      throw new Error(
        `Revoked publication returned ${revoked.status}, not 410.`,
      );
    slug = undefined;

    await jsonRequest(`/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      method: "DELETE",
    });
    artifactId = undefined;
    const deletedAsset = await fetch(
      `${origin}/v1/assets/${encodeURIComponent(assetId)}`,
      {
        method: "DELETE",
        headers: { Accept: "application/json", "X-Device-Token": token },
      },
    );
    if (deletedAsset.status !== 204) {
      throw new Error(
        `Unused image cleanup returned ${deletedAsset.status}, not 204.`,
      );
    }
    assetId = undefined;

    console.log(
      "Live Tapplet flow passed: retrieval, generate, warning-only advisory, revise, restore, image, publish, extend, report, revoke, delete.",
    );
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (slug) {
      try {
        const cleanup = await fetch(
          `${origin}/v1/publications/${encodeURIComponent(slug)}`,
          {
            method: "DELETE",
            headers: { Accept: "application/json", "X-Device-Token": token },
          },
        );
        if (!cleanup.ok && cleanup.status !== 404)
          cleanupErrors.push(`publication cleanup returned ${cleanup.status}`);
      } catch (cleanupError) {
        cleanupErrors.push(
          `publication cleanup failed: ${String(cleanupError)}`,
        );
      }
    }
    if (artifactId) {
      try {
        const cleanup = await fetch(
          `${origin}/v1/artifacts/${encodeURIComponent(artifactId)}`,
          {
            method: "DELETE",
            headers: { Accept: "application/json", "X-Device-Token": token },
          },
        );
        if (!cleanup.ok && cleanup.status !== 404)
          cleanupErrors.push(`artifact cleanup returned ${cleanup.status}`);
      } catch (cleanupError) {
        cleanupErrors.push(`artifact cleanup failed: ${String(cleanupError)}`);
      }
    }
    if (assetId) {
      try {
        const cleanup = await fetch(
          `${origin}/v1/assets/${encodeURIComponent(assetId)}`,
          {
            method: "DELETE",
            headers: { Accept: "application/json", "X-Device-Token": token },
          },
        );
        if (!cleanup.ok && cleanup.status !== 404 && cleanup.status !== 409) {
          cleanupErrors.push(`asset cleanup returned ${cleanup.status}`);
        }
      } catch (cleanupError) {
        cleanupErrors.push(`asset cleanup failed: ${String(cleanupError)}`);
      }
    }
    if (cleanupErrors.length > 0)
      console.error(`Live cleanup warning: ${cleanupErrors.join("; ")}`);
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
