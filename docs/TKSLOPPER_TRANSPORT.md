# tkslopper inference transport

Tapplet can send every model call (generation, revision, repair, publication
review and uploaded-image review) through
[tkslopper](https://github.com/tinkertanker/tkslopper), Tinkertanker's managed
inference boundary. The transport is off by default. The direct provider path
described in the [README](../README.md) remains the rollback path until a
canary has been accepted; a follow-up change can then remove the direct dialect
code and provider keys.

## Model suggestions

The operations panel's direct-provider settings use tkslopper as the source of
model suggestions for provider-key/BYOK configuration, independent of
`INFERENCE_TRANSPORT`. Set `TKSLOPPER_GATEWAY_URL` to the gateway's HTTPS origin.
The panel calls its own authenticated `/v1/admin/model-catalogue` route; the
Worker fetches **public, credential-free** `GET <origin>/v1/model-catalogue`
with no cookies, admin/provider keys, service credential or grant exchange.
This keeps the admin page's `connect-src 'self'` policy unchanged. The source
is never a provider base URL or inferred from a key. Service bindings used for
inference do not replace this public catalogue origin.

Version 1 must be `{object:"list",version:1,data:[{id,provider,display_name,tier,is_default}]}`.
Tapplet validates the provider vocabulary, tier (`economy|balanced|premium`),
string lengths, unique IDs per provider and at most one default per provider.
It rejects redirects and bounds the entire fetch to three seconds, 256 KB and
500 entries. Unavailable/invalid responses use two bundled suggestions:
GPT-6 Luna and Claude Haiku 5.5. A successful catalogue without entries for a
provider uses that provider's bundled suggestion, if any. The panel fetches once
per page load without blocking settings access and labels catalogue/fallback
suggestions. Reload the page to refresh options.

Catalogue IDs stay provider-native, including OpenRouter slugs. Tapplet maps
`opencode` to catalogue `opencode-zen`, and maps `openai-compatible` to `openai`
only at `https://api.openai.com/v1`, or to `deepseek` at
`https://api.deepseek.com` (optionally `/v1`). Other compatible endpoints keep
free-text model entry. `anthropic`, `openrouter` and `opencode-go` map directly.
Gemini entries are recognized but not offered: Tapplet has no Gemini adapter.

Suggestions **never authorize models, change endpoints/keys/transports, or
overwrite saved/custom choices**, even when an ID disappears from the catalogue.
Defaults only initialize a newly selected provider with no in-tab draft. There
is no managed-alias picker: the panel continues to show the configured aliases
read-only. The public catalogue is not authenticated `/v1/models`; it does not
replace authorization-scoped alias discovery or supply a deployed Claude alias.

When managed configuration is valid, the admin overview also reads authenticated
`GET /v1/models` using the existing server-side service-credential/grant helpers
and configured gateway target (including service bindings). Only configured
alias IDs and validated optional `display_name`, `provider`, and `tier` reach
the browser. Labels appear alongside, never instead of, the configured IDs.
The complete metadata read, including waiting for authorization, has a
three-second budget and a 256 KB/500-entry response limit. Missing metadata,
invalid configuration, denial or timeout leaves the ID-only display intact.
Listings are fetched on each overview request with `cache: no-store`; they
are not shared across credentials. The admin response remains private/no-store.
This does not change inference authorization, routing, or configured aliases.

## How it works

- The Worker holds a tkslopper **service credential** (`tksvc_<id>_<secret>`)
  as a Worker secret. iPads never talk to tkslopper: they authenticate to
  Tapplet with class codes and device tokens, and Tapplet keeps prompts,
  validation and quotas server-side. Join-code device activation is not used;
  classroom group keys (`tkgk_`) are used only for
  [class-scoped access](#class-scoped-access).
- The credential is exchanged at `POST /v1/token` on the control plane for a
  15-minute grant covering the three capability aliases. Grants are cached per
  isolate, refreshed when less than 60 seconds remain (or halfway through a
  grant shorter than two minutes), and shared between concurrent requests. The
  exchange has its own 5-second timeout. Keep the environment's token TTL well
  above 60 seconds so grants are reused.
- Model calls go to the gateway's `/v1/responses` (or `/v1/chat/completions`
  for artifacts when configured) with the alias as `model`, an explicit output
  limit, `stream: false` and a fresh `idempotency-key` of the form
  `tapplet:<operation>:<uuid>`. Each call keeps Tapplet's 45-second abort.
- Artifact and moderation requests use strict JSON schemas on both endpoints,
  never `json_object`. Requests omit sampling parameters and seed; system text
  leads the conversation, which starts and ends with a user turn. Image review
  sends images only in the user turn and omits image detail. These requests
  work with Claude-backed capabilities without sending provider-specific fields.
  Choose an authorized versioned alias from `/v1/models` and configure it
  explicitly; a physical Claude/OpenAI model ID is not a managed alias. Tapplet
  does not invent or replace aliases, and never calls a managed `/v1/messages`.
- Only portable reasoning efforts are sent. `xhigh` and `max` become `high`,
  `minimal` becomes `low`, and `none` omits reasoning. `thinking`,
  `reasoning.exclude` and provider attribution headers are never sent. Until
  tkslopper issue #13 lands, `high` is the portable high effort and is not the
  same as today's direct `xhigh`.
- A result counts only when it is complete: Responses `status: "completed"`
  with non-empty output text and no refusal, or Chat `finish_reason: "stop"`
  with non-empty content. Truncated, incomplete, refused and empty results are
  errors, never partial artifacts.
- Errors keep Tapplet's existing mapping: 429 and 5xx are retryable (HTTP 503
  to the iPad), everything else is not (HTTP 502). A gateway 401 drops the
  cached grant and is retried exactly once with a new grant and a new
  idempotency key. A 403 drops the cached grant. Nothing else is retried by
  Tapplet; 502 and 504 are ambiguous and already charged.
- Requests larger than `TKSLOPPER_MAX_REQUEST_BYTES` are rejected before any
  network call. Oversized or failed image reviews return the usual "review
  unavailable" advisory warning.
- `model_call` traces record the alias as `configuredModel`, the returned
  alias as `resolvedModel`, the response id and the gateway's
  `x-tkslopper-request-id` as `gatewayRequestId`. Credentials, grant tokens
  and payloads are never logged or traced.
- The D1 admin model override is ignored while the transport is `tkslopper`.
  The operations panel shows "Transport: tkslopper (admin model override
  inactive)" and the configured aliases. Revisions record
  `tkslopper:<artifact alias>` as their model version.

## Class-scoped access

A class code can carry a tkslopper classroom **group key** (`tkgk_…`). iPads
that join with that code then use the class's tkslopper policy instead of the
fleet configuration, much like Playground Pal's class access: tkslopper decides
which aliases the class may use and enforces its budget, rate limits, schedule,
pause and revocation. The iPad still only talks to Tapplet; the key stays on
the Worker, encrypted in D1 with `ADMIN_ENCRYPTION_KEY` and bound to its class
row.

- On registration the Worker records which class row the new device joined
  (`device_classes`), in the same D1 transaction as the activation. Devices
  registered before migration `0015` have no class and keep the fleet path.
- For a device whose class has a key, generation, revision, repair,
  publication review and uploaded-image review send the key directly as the
  gateway Bearer credential. There is no grant exchange, no control-plane call
  and no 401 retry. Devices without a class key use the fleet configuration
  (direct provider or service credential) unchanged.
- Class access needs `TKSLOPPER_GATEWAY_URL` (or the `TKSLOPPER_GATEWAY`
  binding) and the three alias variables, but not the control plane or service
  credential, and it works while `INFERENCE_TRANSPORT=direct`. An unsupported
  `INFERENCE_TRANSPORT` value still stops all model calls, including classes.
- A class never falls back to the fleet configuration. A missing gateway or
  alias setting, an undecryptable key, or a gateway 401/402/403 fails that
  request. The iPad shows "Your class has used its AI allowance" (HTTP 429,
  `CLASS_AI_ALLOWANCE_REACHED`) for a 402, and "AI is not available for your
  class right now" (HTTP 403, `CLASS_AI_UNAVAILABLE`) for a 401 or 403.

### Operator setup

1. In the tkslopper dashboard, create a class in Tapplet's product and
   environment with Tapplet's three aliases approved, and one group for the
   whole Tapplet class. Every iPad in the class shares that group's allocation
   and per-group RPM, TPM and concurrency, so size them for the class rather
   than one student. Issue the group's API key.
2. In Tapplet's operations panel, either paste the key when minting the class
   code, or use **Class AI access** with an existing code (full or short form)
   to attach, replace or remove it. Tapplet checks the key against the
   gateway's `/v1/models`: unknown keys and keys missing any configured alias
   are rejected. A class that is paused or has not started yet (403), or an
   unreachable gateway, is saved with a warning.
3. Pause, top up, extend or revoke the class in tkslopper. To rotate, issue a
   new key in tkslopper and attach it to the same class code; iPads already in
   the class pick it up on their next request. Removing the key returns the
   class to the fleet configuration.

## Configuration

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `INFERENCE_TRANSPORT` | var | `direct` | `direct` or `tkslopper`. Any other value disables model calls. |
| `TKSLOPPER_CONTROL_PLANE_URL` | var | none | HTTPS. |
| `TKSLOPPER_GATEWAY_URL` | var | none | HTTPS. |
| `TKSLOPPER_SERVICE_CREDENTIAL` | secret | none | `wrangler secret put`; never a var. |
| `TKSLOPPER_ARTIFACT_ALIAS` | var | none | Generation, revision and repair. |
| `TKSLOPPER_REVIEW_ALIAS` | var | none | Publication moderation. |
| `TKSLOPPER_IMAGE_ALIAS` | var | none | Uploaded-image review. |
| `TKSLOPPER_ARTIFACT_EFFORT` | var | `high` | `low`, `medium`, `high` or `omit`. Direct-provider values are translated: `xhigh` and `max` to `high`, `minimal` to `low`, `none` to `omit`. |
| `TKSLOPPER_REVIEW_EFFORT` | var | `low` | As above. |
| `TKSLOPPER_IMAGE_EFFORT` | var | `omit` | As above. |
| `TKSLOPPER_ARTIFACT_ENDPOINT` | var | `responses` | `responses` or `chat`. Review and image calls always use Responses. |
| `TKSLOPPER_MAX_REQUEST_BYTES` | var | `1048576` | Must not exceed the gateway's effective limit, the smaller of its `MAX_BODY_BYTES` and the environment's `max_request_bytes`. |
| `TKSLOPPER_GATEWAY`, `TKSLOPPER_CONTROL_PLANE` | service binding | none | Optional, same Cloudflare account only. Used instead of the URLs when present. |

Aliases must match `^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$`. If the transport is
`tkslopper` and any required value is missing or invalid, every model call
fails (HTTP 503 to the iPad) and the Worker logs a reason naming each bad
setting; the operations panel shows the same reason. Tapplet never falls back
to the direct providers on its own. When a service binding is present its URL
may be left empty; a URL that is set must still be an HTTPS origin with no
path.

## Operator setup in tkslopper

Tapplet does not create any of this; tkslopper operators set it up per stage.

- Product `tapplet`, one environment per stage, and a service credential
  entitled to the three aliases.
- Aliases on the `responses` endpoint, and also on `chat` for the artifact
  alias if `TKSLOPPER_ARTIFACT_ENDPOINT=chat`:
  - Artifact alias: `allow_structured_json`, `allow_reasoning`,
    `max_output_tokens` of at least 32,000, and `max_input_tokens` of at least
    the largest serialised generate or repair body. Two 200 KB exemplars can
    exceed 450,000 bytes after JSON escaping.
  - Review alias: `allow_structured_json`, `allow_reasoning` unless the review
    effort is `omit`, `max_output_tokens` of at least 500, and
    `max_input_tokens` of about 260,000.
  - Image alias: `allow_images`, `max_output_tokens` of at least 500, and
    `max_input_tokens` of at least the image body size. A 2 MB JPEG is about
    2.7 MB of base64, and image requests reserve the whole alias input ceiling.
- Environment `max_request_bytes` of at least 3,145,728 if full canonical
  images are reviewed, with `TKSLOPPER_MAX_REQUEST_BYTES` set to match.
- Rate, token, concurrency and daily budget limits sized for the whole Tapplet
  fleet. All traffic shares one principal, and the defaults (100,000 tokens per
  minute, concurrency 2, one cent a day) would reject most generations.
- Route deadlines of 40 seconds or less, so the gateway answers 504 before
  Tapplet's 45-second abort. Each route's model must echo the exact configured
  model id; tkslopper fails closed with 502 on any mismatch, including dated
  snapshot names.

## Rollout and rollback

1. Before cutover, check `model_call` `durationMs` in the operational traces.
   If p95 for generate, revise or repair is near 40 seconds, agree a longer
   envelope with the operators first: raise the route deadline and Tapplet's
   abort together, keeping the route deadline below Tapplet's abort. Keep the
   whole request inside the iPad's 150-second timeout. In the common case one
   generation makes up to three model calls (generate and two repairs) behind
   a cached grant, so 45 seconds per call just fits. A grant refresh (up to
   6 seconds per call) or the single 401 retry (another exchange and call) can
   push the worst case past 150 seconds, so if p95 is high, keep route
   deadlines well under 40 seconds rather than raising Tapplet's abort.
2. Store the credential for the target stage:
   `npx wrangler secret put TKSLOPPER_SERVICE_CREDENTIAL --profile tinkertanker`.
3. Set the URLs and aliases. If full canonical images should be reviewed, ask
   the operators to raise the environment's `max_request_bytes` to at least
   3,145,728 and set `TKSLOPPER_MAX_REQUEST_BYTES` to match; with the 1 MiB
   default, JPEGs above roughly 780 KB return "review unavailable". Then set
   `INFERENCE_TRANSPORT=tkslopper` in a non-production environment and
   deploy. Run the live flow, including an image upload and a publication.
4. Repeat as a production canary. Keep the direct provider secrets in place
   until the canary is accepted.
5. To roll back, set `INFERENCE_TRANSPORT=direct` and redeploy. Tapplet never
   switches back automatically after a tkslopper error, because that would
   double-charge ambiguous attempts and hide kill switches.

For a local transport smoke test, bind the local tkslopper dev Workers as the
`TKSLOPPER_GATEWAY` and `TKSLOPPER_CONTROL_PLANE` service bindings (the URL
variables may then be left empty). The dev gateway's fixture route returns a
well-formed envelope whose output text is `fixture response`, which is not
JSON. Generation therefore spends its repairs and ends with invalid model
output, publication review reports malformed JSON, and image review reports
unavailable. Use it for authentication and transport smoke tests only, not
artifact semantics.
