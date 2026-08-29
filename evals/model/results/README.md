# Evaluation result schemas

Current generation runs write `latest.v3.json`; multi-configuration ablations
write `latest-ablation.v3.json`; moderation independently writes
`latest-moderation.v2.json`. Generation version 3 results include the Git
commit, prompt version, source-patch and corpus hashes, provider configuration
without credentials, execution environment, policy/ablation settings,
distributions, and metadata-only operational and browser traces. They retain
stable check/issue kinds but never criteria or scenario text, briefs, prompts,
HTML, images, console text, exception text, learner/teacher data, or API keys.

`latest.v2.json` preserves the incompatible pre-privacy generation schema,
which retained issue messages and criteria text. It must not be compared with
schema 3 or treated as a current result.

`archive/*.legacy.json` preserves the incompatible 18 July 2026 result shape.
Those files predate production-path evaluation and lack sufficient provenance;
their rates must not be compared directly with current runs. The added
`legacy-pre-v2` marker labels the historical schema without reinterpreting its
measurements.
