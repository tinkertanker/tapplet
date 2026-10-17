import { DEVICE_TOKEN_RECOVERY_DAYS, networkHashFrom, ownerCredentialFrom } from "../auth";
import { apiError, HttpError, json, readJson } from "../http";
import type { ContentReportReason } from "../storage/repository";
import { obj, REASONS, SLUG } from "../appInput";
import { publication } from "../appResponses";
import type { RouteRequest, StudioContext } from "../appContext";

export async function publicationRoutes(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now } = app;
  const { r, s } = incoming;
  if (s[0] === "v1" && s[1] === "publications" && s[2] && SLUG.test(s[2])) {
    const p = await d.repository.getPublication(s[2]);
    if (s[3] === "reports" && r.method === "POST") {
      if (!p || p.revokedAt || Date.parse(p.expiresAt) <= now().getTime())
        throw new HttpError(404, "PUBLICATION_NOT_FOUND", "Unavailable.");
      const reason = obj(await readJson(r, 1000)).reason;
      if (typeof reason !== "string" || !REASONS.has(reason))
        throw new HttpError(
          422,
          "INVALID_REPORT_REASON",
          "Choose a valid reason.",
        );
      const timestamp = now(),
        date = timestamp.toISOString().slice(0, 10);
      if (
        !(await d.repository.consumeGeneration(
          `network-report:${await networkHashFrom(r)}`,
          date,
          20,
        ))
      )
        throw new HttpError(
          429,
          "REPORT_RATE_LIMIT_REACHED",
          "This network has sent enough reports for today.",
        );
      if (
        !(await d.repository.createContentReport({
          id: crypto.randomUUID(),
          publicationSlug: p.slug,
          reason: reason as ContentReportReason,
          now: timestamp.toISOString(),
          maximumPerPublication: 100,
        }))
      )
        throw new HttpError(
          429,
          "REPORT_LIMIT_REACHED",
          "Report limit reached.",
        );
      return new Response(null, { status: 204 });
    }
    const c = await ownerCredentialFrom(
      r,
      d.config.deviceTokenSigningSecret,
      now().getTime(),
      d.repository,
    );
    if (r.method === "DELETE")
      return (await d.repository.revokePublication(
        s[2],
        c.ownerHash,
        now().toISOString(),
      ))
        ? new Response(null, { status: 204 })
        : apiError(404, "PUBLICATION_NOT_FOUND", "Unavailable");
    if (r.method === "PATCH") {
      const b = obj(await readJson(r, 1000));
      if (
        b.days !== undefined &&
        (!Number.isInteger(b.days) ||
          (b.days as number) < 1 ||
          (b.days as number) > 365)
      )
        throw new HttpError(
          422,
          "INVALID_EXPIRY",
          "Extension days must be a whole number from 1 to 365.",
        );
      const n = (b.days as number | undefined) ?? d.config.publicationTtlDays,
        max = new Date(
          c.expiresAt + DEVICE_TOKEN_RECOVERY_DAYS * 86400000,
        ).toISOString(),
        x = await d.repository.extendPublication(
          s[2],
          c.ownerHash,
          now().toISOString(),
          n,
          max,
        );
      if (x.status !== "extended")
        throw new HttpError(
          x.status === "not-found" ? 404 : 422,
          x.status === "not-found"
            ? "PUBLICATION_NOT_FOUND"
            : "PUBLICATION_EXPIRY_LIMIT_REACHED",
          "Cannot extend publication.",
        );
      return json({
        publication: publication(x.publication, d.config.publicPlayerOrigin),
      });
    }
  }
  return undefined;
}
