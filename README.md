# Tapplet

**Create tiny interactive tapplets for any lesson.** Tapplet Studio is Tinkercademy's teacher-facing, iPad-first SwiftUI app for creating, adapting, previewing and sharing self-contained classroom activities.

## Architecture

- `apps/ipad`: native SwiftUI app and the canonical bundled example corpus at `Resources/Examples`
- `apps/website`: static public preview site and privacy notice ([`apps/website/README.md`](apps/website/README.md))
- `services/api`: Cloudflare Worker API, D1 migrations and tests
- `scripts` and `evals`: repository, publication and model-quality tooling
- `docs`: product contract and pilot operations

The app bundles reviewed HTML examples and can browse and run them offline. Saved tapplets remain available for offline preview. Generation, revision history, restoration from the service, and publication require the API.

## Native iPad setup (no Node required)

Install Xcode and pinned XcodeGen 2.44.1, then:

```bash
cd apps/ipad
xcodegen generate
cd ../..
xcodebuild -project apps/ipad/Tapplet.xcodeproj -scheme Tapplet \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

If Node is already installed, `npm run ipad:generate` is an equivalent
repository-root convenience command. It does not use `node_modules`.

Run tests on an available iPad simulator:

```bash
xcodebuild -project apps/ipad/Tapplet.xcodeproj -scheme Tapplet \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  CODE_SIGNING_ALLOWED=NO -only-testing:TappletTests test
```

Debug defaults to simulator loopback at `http://127.0.0.1:8787`. A physical iPad cannot reach the Mac through loopback: set `TAPPLET_API_BASE_URL` to an address reachable from that iPad. Release defaults to the deployed API. See [`apps/ipad/README.md`](apps/ipad/README.md) for signing and configuration.

## API and repository tooling

Node.js 22 dependencies are only for development, API and repository tooling; they are never bundled into the native app.

```bash
npm ci
cp services/api/.dev.vars.example services/api/.dev.vars
npm run api:db:migrate:local
npm run api:dev
```

The API selects its text model with `AI_PROVIDER` and `AI_MODEL`. Supported
providers are:

| `AI_PROVIDER` | Credential | Endpoint |
| --- | --- | --- |
| `openai-compatible` | `AI_API_KEY` | `AI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` |
| `opencode` | `OPENCODE_API_KEY` | OpenCode Zen |
| `opencode-go` | `OPENCODE_API_KEY` | OpenCode Go |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter |
| `fixture` | none | deterministic local fixture |

For direct OpenAI, set `AI_BASE_URL=https://api.openai.com/v1` and
`AI_MODEL=gpt-6-luna` (cost-effective), `gpt-6.1-sol` (balanced), or
`gpt-6-astra` (flagship). GPT-5/6 models use Responses with medium reasoning
for artifacts and low for moderation, without sampling parameters. Older
OpenAI models and third-party compatible endpoints retain chat completions.

For native Claude, set `AI_PROVIDER=anthropic` and
`AI_MODEL=claude-haiku-5-5` (cost-effective), `claude-sonnet-5-5` (balanced),
or `claude-opus-5-5` (higher tier), and configure `ANTHROPIC_API_KEY`.
Tapplet uses Messages with strict JSON schemas and adaptive thinking: medium
for artifacts, low for moderation. Thinking blocks are ignored; refusals and
truncated output are errors. Keys stay on the Worker; Anthropic never falls
back to another provider's key or the managed service credential.

The operations panel gets provider-key/BYOK model suggestions from the public
tkslopper catalogue at `TKSLOPPER_GATEWAY_URL`, including when inference uses
the direct transport. No provider key or managed credential is needed to fetch
options. A failed/unconfigured catalogue leaves two bundled defaults (GPT-6
Luna and Claude Haiku 5.5); saved/custom model IDs are always retained. See the
[catalogue contract and provider mapping](docs/TKSLOPPER_TRANSPORT.md#model-suggestions).
Apply migration `0012_anthropic_provider.sql` before saving an
Anthropic admin override; it preserves existing settings and encrypted keys.
No deployment default or managed alias is changed by these suggestions.
For a Claude evaluation use `EVAL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`
(or explicit `EVAL_API_KEY`), and optionally `EVAL_MODEL` / `EVAL_BASE_URL`.
Custom Claude endpoints require an explicit `EVAL_API_KEY`; the Anthropic key
is used only at its official endpoint. Likewise, generic `AI_API_KEY` fallback
requires the evaluation endpoint to match its configured `AI_BASE_URL`.

For OpenCode Zen or Go, use a model ID listed in the provider's endpoint table;
Tapplet supports OpenAI-compatible chat completions and the Responses API used
by `muse-spark-1.2-contributor`. For OpenRouter, use an
OpenRouter model slug. Provider credentials are Wrangler secrets in deployed
environments; never put them in
`wrangler.jsonc`. By default Tapplet requests maximum reasoning for generation,
revision and repair (`max` on OpenCode's DeepSeek chat models and `xhigh` on
Muse Spark and OpenRouter). Set `AI_REASONING_EFFORT` (`minimal`, `low`,
`medium`, `high`, `xhigh` or `max`) to replace that default; an admin override
uses it too. Every model call must finish within Tapplet's 45-second abort, so
check latency before raising effort: maximum reasoning on Muse Spark takes
minutes per call. The deployed default is OpenRouter `openai/gpt-6-luna` at
`low`, about 20 seconds per generation. Uploaded-image safety review uses `gpt-5.6-luna`
through OpenCode Go with reasoning disabled and requires `OPENCODE_API_KEY`.

Setting `INFERENCE_TRANSPORT=tkslopper` instead routes every model call,
including image review, through Tinkertanker's tkslopper gateway using
capability aliases; the default `direct` keeps the providers above. See
[`docs/TKSLOPPER_TRANSPORT.md`](docs/TKSLOPPER_TRANSPORT.md).

Useful commands are `api:dev`, `api:build`, `api:test`, `api:typecheck`, `api:db:migrate:local`, `examples:validate`, `examples:package`, `examples:import`, `eval:artifacts`, `eval:model`, `eval:model-moderation`, `verify:live`, and `class-access:provision`.

Run all offline repository verification with:

```bash
npx playwright install --with-deps chromium webkit # once, for browser tests
npm run verify
npm run api:build
```

`verify` runs root tooling tests, API tests and typechecking, canonical example validation, and artifact evaluation. It deliberately does not claim to compile Swift; native build and tests run separately on macOS CI.

Operational details: [`docs/TAPPLET_PILOT_RUNBOOK.md`](docs/TAPPLET_PILOT_RUNBOOK.md). Product contract: [`docs/TAPPLET_V1.md`](docs/TAPPLET_V1.md). Current first-party colour guidance: [`docs/DESIGN.md`](docs/DESIGN.md).

## Licence

[MIT](LICENSE)
