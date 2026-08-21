# Tapplet V1 product contract

**Tapplet Studio** is the teacher iPad app for making a small, self-contained
**tapplet** and publishing it as one student-facing web link. **Tapplet** is the
product family name: access, the API, and source identities stay Tapplet.

The August 2026 pilot targets 10–20 Singapore upper-primary and secondary
teachers. Tapplet Studio performs generation through the Tapplet API, so it
does not depend on Apple Intelligence.

## Names

- **Tapplet Studio** is the iPad app teachers open.
- A **tapplet** is the HTML classroom activity students open. Write it in
  sentence case (`a tapplet`, `My Tapplets`), not as `a Tapplet`.
- **Tapplet** remains the family name for class-code access and the API.
- Student-facing HTML should not print Tapplet, Tapplet Studio or tapplet
  unless the brief asks for it. Source identities (bundle ID, Worker names,
  D1/R2) stay Tapplet unless a task includes a coordinated migration.

## Product promise

> Make the tapplet your next lesson needs, then share one link.

A tapplet should normally fit one browser viewport and serve one focused
learning purpose. A short linear story may use two or three screens, but
Tapplet Studio is not intended to generate full webpages, dashboards, lessons,
menus or multi-activity labs.

Teachers do not need to start from an empty prompt. They can run and remix a
curated example, start from a ready-made plan, or answer a short guided
interview. Plans and examples include games, quizzes, simulations and practice
activities. Generation uses relevant published and curated examples as
inspiration, and revision always starts from the current HTML rather than
recreating the tapplet from scratch.

## V1 experience

1. Open **Explore**, **Make** or **My Tapplets**.
2. Run/remix an example, start from a plan, or answer the guided questions and approve the brief.
3. Generate the tapplet and interact with it directly in the iPad preview.
4. Ask Tapplet Studio for a change. The working preview remains visible while
   the new revision loads.
5. Restore any earlier revision if the change is not useful.
6. Edit project details such as title, summary, subject, level and tags without
   making a model request.
7. Test the tapplet full-screen.
8. Publish an unlisted URL, then copy it, show its QR code or use the iPad share
   sheet.
9. Extend or revoke the publication from the originating device.

Explore contains the reviewed HTML seed catalogue bundled with the app. My
Tapplets stores local project files and synchronises the server-owned revision
history. The editor is preview-first: there is no raw syntax tree or structural
layout editor.

## Artifact contract

The canonical artifact is one complete HTML document with inline CSS and
JavaScript. The model may use browser APIs available in Safari, but generated
artifacts cannot load packages, contact external services, include credentials,
collect student identity or submit student work. Teacher images use relative
`assets/<assetId>` references and are resolved by the iPad preview and public
publication routes.

The service applies structural checks before saving a generated revision:

- complete HTML document with `doctype`, `head` and `body`;
- at most 200 KB (the generation prompt targets substantially less);
- no external scripts, styles, packages, frames or arbitrary resource URLs;
- no network APIs;
- only existing images owned by the teacher's device;
- one bounded model repair when generated output fails those structural checks.

Deterministic text review runs alongside these checks, but its findings are
advisory: the revision is preserved and the teacher can edit, re-prompt or
continue.

The generation prompt asks for a compact, touch-first classroom applet, one
coherent interaction system and simple readable JavaScript. The model returns
the full HTML document plus an optional design card. The card and project
metadata help future revision, retrieval and remixing; failure to parse the
optional card does not discard otherwise valid HTML.

Generated JavaScript runs only in the tapplet's front end. It has no Tapplet
credentials, cookies or server-side execution path. Student interaction state
is transient browser state.

## System boundary

```text
Tapplet Studio (iPad)
        |
        | HTTPS: generate, revise, history, images, publish
        v
Tapplet API -------> configured text-generation provider
        |
        +----------> D1 metadata, revisions and retrieval index
        |
        +----------> R2 immutable HTML sources, images and snapshots
        |
        +----------> public unlisted HTML URL
                              |
                              v
                       Student Safari
```

Tapplet Studio loads artifact HTML directly into a non-persistent `WKWebView`.
The public URL serves the same immutable source revision directly, with a fixed
report control added by the service. No separate player or proprietary tapplet
language sits between the artifact and the browser.

The Tapplet API remains separate from the Express/Socket.IO classroom server.
It owns model routing, validation and bounded repair, device credentials,
quotas, images, immutable revision history, publication, expiry, reports and
revocation.

## Storage and revision model

- An **artifact** owns editable metadata and points to one head revision.
- A **revision** is immutable and references content-addressed HTML in R2.
- Revising creates a child revision and atomically moves the head when the
  caller still has the expected prior head.
- Restoring history moves the head pointer; it does not copy or mutate source.
- A **publication** snapshots one revision and keeps its slug when republished.
- A **remix** creates a new artifact and records its source revision.
- Revision-to-image references are stored explicitly for deletion and public
  delivery checks.

Every successful private revision remains in the teacher's history. Global
retrieval contains the reviewed seed corpus and at most one published revision
per teacher artifact. Failed generations and unpublished intermediate
revisions are not globally indexed. Retrieval is a rebuildable projection over
titles, descriptions, subjects, levels, interaction patterns and tags; the HTML
sources remain authoritative.

The reviewed corpus is deployed through the authenticated, idempotent seed
import route. Operational secret configuration and import steps live in the
pilot runbook.

## Supported content

The HTML artifact model supports focused quizzes, games, matching/sorting/sequencing,
interactive diagrams, graph explorers, small
simulations, writing tools and other browser-based interactions. These are
authoring and retrieval descriptions, not schema labels that grant special
capabilities.

Larger activities should be split by learning purpose. For example, a
qualitative-analysis catalogue becomes separate one-unknown practice tapplets;
a simulation should centre on one model with its controls, readouts and graph
rather than several unrelated activities.

V1 supports teacher images through Photos, Files and Camera. Inputs remain
size-limited, normalised and stripped of metadata before generated HTML can
reference them. On-device and server AI review may return a visible advisory
warning, but does not discard or block the teacher's image. Invalid files,
ownership, quotas, storage and managed-asset references remain hard constraints.

The same warning-only review applies to teacher prompts, revision instructions,
generated content and publication review. Warnings name the possible concern
and preserve the work so a teacher can edit, re-prompt, remove or continue.
Structural HTML and sandbox controls remain blocking.

## Explicit non-goals

V1 does not provide:

- student accounts, identity, submissions, persistence or analytics;
- student-facing model calls;
- server-side execution of generated code;
- arbitrary packages, external requests, advertising or tracking;
- a generic scene, drawing, physics, particle, action or state-machine DSL;
- raw AST or state-machine authoring;
- automatic conversion of previous prerelease schema experiments;
- full laboratory catalogues inside one artifact.

## Verification gates

- The Tapplet API tests cover generation failure with no persisted revision,
  immutable revisions, optimistic head conflicts, remix lineage, publication
  snapshotting, stable republish slugs, expiry, revocation, quotas, reports,
  image ownership and explicit image liveness.
- All curated seeds pass the shared artifact checks and initialise in jsdom.
- Bundled iPad examples are byte-for-byte copies of the canonical corpus.
- Model evaluation measures first-pass validity, one-repair success and whether
  requested interactions/content appear in the artifact.
- Live verification covers generate, a deliberately triggered warning-only
  advisory, revise, restore, image use, publish, anonymous Safari delivery,
  report, extension, revocation and deletion.
- Before pilot release, the physical iPad flow must complete generation,
  revision while preserving the old preview, history restore, image use, an
  advisory warning with work preserved, publication in Safari and revocation.

This release is a clean pre-launch cutover. Legacy schema drafts and
publications are reset by migration; no conversion or dual renderer is
maintained.
