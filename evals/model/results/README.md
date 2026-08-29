# Evaluation result schemas

Current generation runs write `latest.v2.json`; multi-configuration ablations
write `latest-ablation.v2.json`; moderation writes
`latest-moderation.v2.json`. Version 2 results include the Git commit, prompt
version, source-patch and corpus hashes, provider configuration without
credentials, execution environment, policy/ablation settings, distributions,
and metadata-only operational and browser traces. They never retain briefs,
prompts, HTML, images, console text, exception text, learner/teacher data, or
API keys.

`archive/*.legacy.json` preserves the incompatible 18 July 2026 result shape.
Those files predate production-path evaluation and lack sufficient provenance;
their rates must not be compared directly with version 2 runs. The added
`legacy-pre-v2` marker labels the historical schema without reinterpreting its
measurements.
