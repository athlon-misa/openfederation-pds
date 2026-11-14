This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.


## Themes and appearance

Use **Appearance** in the dashboard header to choose **PDS Basic** (the original neutral styling) or **OpenFederation** (the website's paper/ink/teal palette and typography). Color mode is independent: Light, Dark, or Use device setting. New browsers start with OpenFederation/light. Choices are local to the browser and do not change server configuration or another person's preferences.

Presets live in `src/lib/appearance.ts` and `src/app/globals.css`; `data-theme` is placed on the document root so dialogs and dropdowns inherit it. `next-themes` controls only the `.dark` class. Keep both light/dark token sets in sync when adding a preset, and preserve semantic state colors and keyboard focus visibility.

The branded theme references [OpenFederation's website](https://www.openfederation.net/) and its Public Sans, Source Serif 4, and JetBrains Mono typography. PDS Basic retains Geist. Fonts are self-hosted through Next's font build pipeline.

Users filters are URL-backed, including `/admin/users?status=pending`. Search waits 300 ms before changing the query; changing a filter resets pagination. Admin tables distinguish initial request failures from background refresh failures with cached rows.

After `npm ci` in both the repository root and `web-interface`, run `npm run test:web` from the root for appearance, URL-filter, and DOM interaction checks. These tests do not use PostgreSQL. Also run frontend `npm run lint` and `npm run build`. The setup wizard is rendered by the backend and is outside dashboard theming.

Table empty states use a centered text panel outside the table's horizontal scroll area, with page-specific guidance. The glossary stays publicly readable and uses the shared sidebar/header for signed-in readers.

Search results own a single scroll area sized to the viewport. Page layout rules are shared across themes: administrative tables use available width, independent settings/glossary sections flow into responsive columns, and account overview panels use their available container width. Explanation labels stack inside narrow cards rather than following the overall screen width.
