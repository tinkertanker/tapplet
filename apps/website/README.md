# Tapplet preview website

A dependency-free static site: a "coming soon" landing page and the public
privacy notice. It is deployed as the static assets-only Worker
`tapplet-preview` and is separate from the API Worker in `services/api`. It
has no Worker script, bindings, D1/R2 resources or secrets, and its only route
is the `tapplet.tk.sg` custom domain.

Public URLs:

- <https://tapplet.tk.sg/>: landing page
- <https://tapplet.tk.sg/privacy>: privacy notice

`/admin` and `/v1/admin/*` on the same host are not part of this site: zone
routes attach them to the API Worker, which serves the operations panel (see
[`docs/TAPPLET_PILOT_RUNBOOK.md`](../../docs/TAPPLET_PILOT_RUNBOOK.md)).

The Worker's workers.dev URL remains available as a fallback. The custom domain
is attached separately through Cloudflare's supported API without reuploading
assets; `wrangler.jsonc` retains it so future authorised deployments keep it.

- `public/index.html`: landing page
- `public/privacy/index.html`: privacy notice, served at `/privacy`
- `public/404.html`: served for unknown paths with status 404
- `public/styles.css`: shared styles using the colour roles in
  [`docs/DESIGN.md`](../../docs/DESIGN.md)
- `public/AppIcon-1024.png`: unmodified copy of the iPad app icon
- `public/_headers`: security headers for every response

Keep the privacy notice consistent with the app's privacy manifest and the API's
storage, AI and cleanup behaviour, and update its date when it changes.

## Commands

Run from the repository root:

```bash
npm run website:test
```

Run from `apps/website`, using the repository's installed Wrangler:

```bash
# Local preview at http://localhost:8788
../../node_modules/.bin/wrangler dev --port 8788

# Validate the configuration and bundle without publishing
../../node_modules/.bin/wrangler deploy --dry-run

# Publish to tapplet.tk.sg and workers.dev
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_KEY_TT" ../../node_modules/.bin/wrangler deploy
```

Never paste the token value into commands, files or logs.
