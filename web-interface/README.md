# OpenFederation dashboard

The web dashboard for an OpenFederation PDS: sign-up and sign-in, communities, the account area, pen names, and the admin pages. Next.js 16 (App Router), shadcn/ui, React Query and Zustand. It talks to the PDS over XRPC and keeps no data of its own.

## Development

Run a PDS first (from the repository root: `npm run dev`, port 3000), then:

```bash
cd web-interface
npm install
cp .env.example .env.local   # NEXT_PUBLIC_PDS_URL=http://localhost:3000
npm run dev                  # http://localhost:3001
```

`npm run build` and `npm start` (port `$PORT`, default 3000) run the production build.

## Which PDS it talks to

- `NEXT_PUBLIC_PDS_URL`: the PDS's public URL, built into the bundle.
- `PDS_URL`: read when the dashboard runs, and wins over `NEXT_PUBLIC_PDS_URL`. The container image (`Dockerfile.image`) uses it, so one image serves any PDS; the address reaches the browser through `/runtime-config.js`.
- `NEXT_PUBLIC_PDS_SERVICE_DID` (optional): the PDS's service DID; pen-name sign-ins refuse a server that names another.

The PDS must list the dashboard's origin in its `CORS_ORIGINS`.

## Tests

From the repository root, after `npm ci` there and in `web-interface`: `npm run test:web` (Vitest, jsdom, no database). On Node 26 run it with `NODE_OPTIONS=--no-experimental-webstorage`. In `web-interface`, also run `npm run lint` and `npm run build`.

## Themes and appearance

Use **Appearance** in the dashboard header to choose **PDS Basic** (the original neutral styling), **OpenFederation** (the website's paper/ink/teal palette and typography) or **Open Newsrooms**, or to use the server's default look (`DEFAULT_APPEARANCE`, set on Admin → Server settings). Color mode is independent: Light, Dark, or Use device setting. Choices are local to the browser and do not change server configuration or another person's preferences.

Presets live in `src/lib/appearance.ts` and `src/app/globals.css`; `data-theme` is placed on the document root so dialogs and dropdowns inherit it. `next-themes` controls only the `.dark` class. Keep both light/dark token sets in sync when adding a preset, and preserve semantic state colors and keyboard focus visibility.

The branded theme references [OpenFederation's website](https://www.openfederation.net/) and its Public Sans, Source Serif 4, and JetBrains Mono typography. PDS Basic retains Geist. Fonts are self-hosted through Next's font build pipeline.

Users filters are URL-backed, including `/admin/users?status=pending`. Search waits 300 ms before changing the query; changing a filter resets pagination. Admin tables distinguish initial request failures from background refresh failures with cached rows.

After `npm ci` in both the repository root and `web-interface`, run `npm run test:web` from the root for appearance, URL-filter, and DOM interaction checks. These tests do not use PostgreSQL. Also run frontend `npm run lint` and `npm run build`. The setup wizard is rendered by the backend and is outside dashboard theming.

Table empty states use a centered text panel outside the table's horizontal scroll area, with page-specific guidance. The glossary stays publicly readable and uses the shared sidebar/header for signed-in readers.

Search results own a single scroll area sized to the viewport. Page layout rules are shared across themes: administrative tables use available width, independent settings/glossary sections flow into responsive columns, and account overview panels use their available container width. Explanation labels stack inside narrow cards rather than following the overall screen width.
