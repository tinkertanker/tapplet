# Tapplet app icon

The iPad app icon is the "Pressed Applet" mark: a coral keycap-style tile —
one small applet — caught mid-tap, tilted with soft press ticks above and
below. It sits on the warm-paper field and uses only brand colours from
[`DESIGN.md`](DESIGN.md): coral `#F05D57`, dark coral `#BD3A34`, warm paper
`#F8F6F1`.

## Source of truth

- Master vector: [`assets/app-icon-master.svg`](assets/app-icon-master.svg)
  (512-unit viewBox, exported at 1024×1024).
- Shipped raster: `apps/ipad/Sources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`.
- The 1024 master is deliberately square with a full-bleed background; iOS
  applies the superellipse mask itself. Do not pre-round the corners or add
  transparency.

To regenerate the PNG, rasterise the SVG at 1024×1024 (any renderer; a
headless-Chromium screenshot of the SVG in a zero-margin page works) and
replace the file in the appiconset.

## Design spec

Geometry in the SVG's 512-unit space, all applied as one group transform
`translate(0 -46) rotate(-9 256 296)`:

| Element | Value |
| --- | --- |
| Keycap face | rect 131,212 250×184 r54, `#F05D57` |
| Keycap lip (depth) | rect 143,240 226×170 r50, `#BD3A34` |
| Tilt | −9° about (256, 296) |
| Vertical offset | −46 px |
| Press ticks | 22 px stroke, 20 px long, round caps, `#BD3A34` |
| Top tick set (10:30 / 12 / 1:30) | opacity 0.45 |
| Bottom tick set (7:30 / 6 / 4:30) | opacity 0.30 |

## Motif usage beyond the icon

The mark reappears on Tapplet-owned surfaces as the **Pressed Applet motif**.
Rules when placing it:

- Use the slightly rectangular tile (face proportions 250×184, ~1.36:1) with
  its dark-coral lip — never a square tile.
- Rotation is free: any direction and angle that suits the placement.
- Press ticks are optional, but when present they keep the fixed proportional
  sizes — 22 stroke / 20 length per 250-wide face, round caps, top set at
  0.45 opacity and bottom set at 0.30, at the 10:30/12/1:30 and 7:30/6/4:30
  positions.
- Colours are always brand coral `#F05D57` + dark coral `#BD3A34`.

Current wiring:

- **Shared student pages** (Worker): `/favicon.svg` serves the mark, and the
  publication HTML gets a `<link rel="icon">` injected next to `<base>`
  (`services/api/src/index.ts`); the not-found / unpublished / expired /
  unavailable responses render branded error pages
  (`services/api/src/brand.ts`).
- **iPad app**: the reusable `PressedAppletMark` SwiftUI view
  (`apps/ipad/Sources/Components/PressedAppletMark.swift`) draws the motif at
  any size/rotation; it anchors the empty states in My Applets and Explore.
  Prefer it over new one-off artwork; leave T Krobot placements
  (`TKRobotStickerView`) as the character voice and the motif as the product
  voice.

## Exploration history

The full icon exploration — interview constraints, both design directions
(Pressed Applet and Squircle Ripple), variants, size tests, and favicon
reductions, with live sliders for every parameter above — is preserved as a
Claude artifact: https://claude.ai/code/artifact/0c732a41-f45c-4359-823d-9a09cdbea09d

The runner-up ("Squircle Ripple" B8: a 3×3 applet grid cropped by the
squircle, final state zoom 1.1 / gap 24) was not shipped but is a candidate
motif for the shared student page, splash, or marketing.

Favicon reduction for the shared page: the resting keycap tile alone (no
tilt, no ticks) — see the artifact's favicon board.
