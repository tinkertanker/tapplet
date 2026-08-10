# Tapplet design guide

This guide currently defines only Tapplet's first-party colour system. Layout,
typography, motion and illustration rules have not been standardised here yet.
Follow native iPad patterns and nearby components for those decisions rather
than treating this document as a complete design system.

## Scope

These colours apply to the SwiftUI app chrome: navigation, buttons, filters,
forms, cards, status and feedback. Their source of truth is
`apps/ipad/Sources/Design/TappletTheme.swift`; the asset-catalog `AccentColor`
must match the primary action accent.

Do not apply this palette automatically to:

- `apps/ipad/Resources/Examples`, whose reviewed student activities use their
  own content-appropriate palettes;
- generated or teacher-authored applet HTML shown in the preview;
- T Krobot mascot art or the app icon, which are curated source assets and need
  an explicit artwork decision before recolouring;
- technical image-processing backgrounds such as the white image-normalisation
  canvas.

## Brand basis

Tinkercademy's official colour icon and current website use coral, near-black
and white. The logo coral is `#F05D57`; the website uses the darker
`#BD3A34` for filled actions because white text on the brighter coral does not
meet normal-text contrast. Warm paper neutrals are shared with the wider
Tinkertanker identity.

Blue is not a Tinkercademy interaction colour. Do not add a generic blue accent
for buttons, links, selection or status. A content-specific applet may still use
blue within its own isolated design.

## Semantic palette

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Canvas | `canvas` | `#F8F6F1` | App and sidebar background |
| Surface | `surface` | `#FFFFFF` | Cards, search fields and sheets |
| Primary accent | `accent` | `#BD3A34` | Prominent actions, links, progress and active navigation |
| Brand coral | `accentBright` | `#F05D57` | Logo-aligned punctuation and focus emphasis, not normal text on light backgrounds |
| Soft coral | `accentSoft` | `#FBEEED` | Restrained brand-tinted surfaces, not applied-filter state |
| Applied-filter ink | `filterSelection` | `#7C5200` | Text, checkmark and border for an applied filter |
| Applied-filter fill | `filterSelectionSoft` | `#F8ECCB` | Selected subject/topic pills only |
| Secondary-action fill | `secondaryActionSoft` | `#ECE8DF` | Explicit secondary buttons and suggestion chips, with `ink` text |
| Ink | `ink` | `#171718` | Primary text and secondary-action labels |
| Muted ink | `mutedInk` | `#6F6D67` | Metadata, supporting copy and neutral status |
| Border | `border` | `#DFDEDA` | Cards, controls and unselected pills |
| Danger | `danger` | `#9A2C27` | Error and destructive text/icons |
| Danger fill | `dangerSoft` | `#FBE7E5` | Error panels |

## Usage rules

### Actions

- Use `.borderedProminent` with the global accent for the single main action in
  a local group. White on `accent` is 5.50:1.
- Use `TappletSecondaryButtonStyle` for explicit secondary actions. It renders
  near-black text on warm greige rather than asking SwiftUI to derive a pale
  coral fill from the global tint.
- Plain actions and links may use `accent`. Do not fill every available action;
  hierarchy comes from reserving the solid accent for the productive next step.
- Destructive controls must use a destructive role, explicit wording and an
  icon or confirmation where appropriate. Because the brand is red-adjacent,
  never rely on hue alone to distinguish deletion from a primary action.

### Applied filters and navigation

- Honey has one meaning: a subject or topic filter is currently applied. Keep
  the checkmark and accessibility selected trait; colour is supplementary.
- Do not use honey for generic badges, metadata, warnings, navigation selection
  or decoration.
- Navigation follows the global coral accent. Neutral statuses such as “Ready”
  use `mutedInk`, not an action colour.

### Brand and supporting colour

- Use bright coral sparingly for brand punctuation such as the short page-header
  rule. Bright coral on the canvas is suitable for non-text emphasis, not small
  text.
- Card subject eyebrows and reset links use the darker `accent` so they remain
  readable.
- Do not assign different colours to school subjects. Subject identity belongs
  in labels and filters, not a rainbow card system.

## Contrast reference

The intended normal-text pairs meet WCAG 2.x AA:

| Pair | Contrast |
| --- | ---: |
| White on `accent` | 5.50:1 |
| `accent` on `canvas` | 5.09:1 |
| `filterSelection` on `filterSelectionSoft` | 5.83:1 |
| `ink` on `secondaryActionSoft` | 14.65:1 |
| `ink` on `surface` | 17.92:1 |
| `mutedInk` on `surface` | 5.17:1 |

`#F05D57` with white is only 3.28:1. Never use that pair for normal-sized text.
Selection, error and status must also communicate through labels, symbols,
traits or structure rather than colour alone.
