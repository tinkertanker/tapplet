# Tapplet Studio Build 5 screenshots

Nine full-screen portrait captures, losslessly optimised for reuse in documentation
and communications. These are **local Release 0.1.0 (5) simulator recompilation
captures, NOT screenshots of installed TestFlight** or Apple's shipped binary.

## Provenance and limits

- Exact Build 5 source: [`00e43028793f4ad2061036336927edda6e53a210`](https://github.com/tinkertanker/tapplet/commit/00e43028793f4ad2061036336927edda6e53a210).
- Local build: Release / iphonesimulator, `CURRENT_PROJECT_VERSION=5`.
- Device: iPad Air 13-inch (M4), iOS 26.5 (23F73), Xcode 26.6 (17F113),
  hosted macOS 26.6.2 (25G83). All images are **2048 × 2732**.
- Capture investigation: [archived Amp thread](https://ampcode.com/threads/T-615228b6-711c-4f79-8564-d3dbc59a1f25)
  and [original Devin session](https://app.devin.ai/sessions/fffe447e48434584ae2dccc1d7c52b46).
- No live AI generation, revision or publication was captured. No authorised demo
  code was available; the local simulator build lacked Keychain entitlements.
  Live activation and a populated personal library were not exercised.
- No crop, resize, retouching or recreated UI. Existing viewport-edge clipping
  and the small gray corner mark are retained. No visible credentials or student
  personal data were found during inspection.
- Only the selected PNGs and this documentation are checked in. Private App Store
  Connect receipts, raw logs and the archive's reports are intentionally excluded.

## Real-app states

These seven captures use normal app launch, without UI-test flags.

| Image | Caption |
| --- | --- |
| [01-access-screen.png](real-app/01-access-screen.png) | Start screen: browse examples immediately; the six-digit class-code field is empty. |
| [02-explore-library.png](real-app/02-explore-library.png) | Explore: 18 ready-made lessons with search and form/subject filters. |
| [03-example-conductor-insulator.png](real-app/03-example-conductor-insulator.png) | Bundled Primary 5 Science conductor/insulator game, initially 0/8 sorted. |
| [04-example-interaction-feedback.png](real-app/04-example-interaction-feedback.png) | Two actual correct sorts produce explanatory feedback; this is a bundled activity, not newly generated AI output. |
| [05-sidebar-explore.png](real-app/05-sidebar-explore.png) | Navigation: Explore, Make, My Tapplets, access status and Send feedback. |
| [06-my-tapplets-empty.png](real-app/06-my-tapplets-empty.png) | First-use My Tapplets library with creation, examples and restoration actions. |
| [07-make-access-gate.png](real-app/07-make-access-gate.png) | Make requests access; the class-code field is blank. Underlying bottom navigation is partly clipped. |

## Supplemental creation UI — test fixtures only

Keep these separate and retain the **UI-test fixture** qualification wherever
they are used. They render the unchanged app using its existing
`--ui-testing-reset` launch argument, not live activation or AI generation.

| Image | Caption |
| --- | --- |
| [08-FIXTURE-make-plan-view.png](supplemental-fixtures/08-FIXTURE-make-plan-view.png) | Creation UI (fixture): choose a starter plan or answer six guided questions. Bottom navigation is partly outside the viewport. |
| [09-FIXTURE-make-check-answers.png](supplemental-fixtures/09-FIXTURE-make-check-answers.png) | Lesson brief (fixture): review a Primary 5 Science sorting game, feedback and five-minute classroom context. |

## Lossless optimisation and verification

Applied OptiPNG 0.7.7 to each copied PNG:

```sh
optipng -o5 -preserve <image.png>
```

For every original/optimised pair, decoded with ImageMagick to 8-bit RGBA
(`magick <image.png> -alpha on -depth 8 rgba:-`) and compared SHA-256 hashes.
**9/9 matched exactly**, each decoding to 22,380,544 bytes; all dimensions
remain 2048 × 2732. Ancillary PNG chunks, including any colour metadata, also
match the originals. All nine states were visually inspected. Compression and
lossless channel reduction changed storage only, not pixels or readable UI.

| Image | Original bytes | Optimised bytes | Saved |
| --- | ---: | ---: | ---: |
| 01-access-screen | 1,491,752 | 912,762 | 38.81% |
| 02-explore-library | 1,525,288 | 850,141 | 44.26% |
| 03-example-conductor-insulator | 249,338 | 114,947 | 53.90% |
| 04-example-interaction-feedback | 254,102 | 119,217 | 53.08% |
| 05-sidebar-explore | 1,091,361 | 622,005 | 43.01% |
| 06-my-tapplets-empty | 664,000 | 331,178 | 50.12% |
| 07-make-access-gate | 1,257,997 | 748,841 | 40.47% |
| 08-FIXTURE-make-plan-view | 1,697,492 | 948,517 | 44.12% |
| 09-FIXTURE-make-check-answers | 1,243,548 | 640,306 | 48.51% |
| **Total** | **9,474,878** | **5,287,914** | **44.19%** |

Total saving: **4,186,964 bytes**. Original inputs came from the private
`tapplet-build5-assets.zip` supplied with the capture handoff; they are not
duplicated in this repository.
