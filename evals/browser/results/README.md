# Browser evaluation result schemas

Current corpus runs write `latest.v2.json`. Browser schema 2 stores only stable
scenario indexes, check booleans, counts, geometry, and provenance metadata; it
does not retain caller-supplied scenario names or artifact content.

`latest.v1.json` preserves the incompatible schema 1 snapshot, which predates
fresh-page control isolation and actionability checks. Do not compare its pass
rates directly with schema 2.
