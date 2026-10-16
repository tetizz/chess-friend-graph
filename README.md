# Chess Friend Graph

Explore Chess.com’s titled players by rating and public friend count. Built in the same warm, dark style as the tetizz chess projects.

[Open the live site](https://tetizz-chess-friend-graph.pages.dev/).

## Explore

- Bullet, blitz, rapid, and an overall average of all three.
- Search, title and precision filters, numeric ranges, and sortable player results.
- A responsive scatter plot with clickable players, zoom, and a log scale.
- Player details and side-by-side comparisons.
- Share a filtered view, download CSV data, or save the graph as an image.
- Light and dark themes, keyboard shortcuts, and reduced-motion support.
- A separate GM explorer with saved public friend lists, search, pagination, and downloads.

The site displays dated public observations. Complete saved directory page coverage means every recorded page position was captured; it does not establish a live or simultaneous census. Card observations can repeat across captures, so distinct directory accounts are separate from the broader dated roster union. Friend-count and rating coverage remain separate: missing values stay unknown, and a `999+` display is a lower bound. An overall rating appears only when all three time controls are available; it is a descriptive average, not an official Chess.com rating. Friend counts do not identify who sent a friend request or measure activity.

Titles follow Chess.com’s displayed badges, including its Master (M) badge.

The GM explorer keeps complete, partial, and unknown lists distinct. It loads each saved list when selected and shows count, list, and roster observation dates separately. A saved count does not establish list completeness. These are dated public captures; accounts and friendships may have changed since they were observed.

## Run

```sh
npm ci
npm test
npm run build
npm run dev
```

## Refresh the published data

Use the separate collector project’s selected, validated MAIN publication:

```sh
node scripts/export-public-data.mjs --source /path/to/chess-friend-graph --output public/data/dataset.json
npm test
npm run build
```

The export verifies the selected publication’s manifest and compact index, then includes only public display fields. Raw response proofs, local evidence, personal comparison flags, and credentials are excluded. The source project and its accepted candidates are never modified.

The GM export reads the selected GM publication’s compact index and bounded individual lists:

```sh
node scripts/export-public-gm-data.mjs --source /path/to/chess-friend-graph --output public/data/gm
```

It writes a separate immutable public generation under `public/data/gm/`, preserving the collector’s generation as `baseGmGeneration`. Audited supplemental lists require an independently supplied manifest digest via `--supplement <manifest.json> --supplement-sha256 <digest>`; they update only their target lists and preserve the saved count observations. The local `current.json` selector is build input and is never packaged.

## Cloudflare Pages

The deployment target is [tetizz-chess-friend-graph.pages.dev](https://tetizz-chess-friend-graph.pages.dev/), using the Pages project `tetizz-chess-friend-graph`. Deployment and live verification are separate steps; changing this configuration does not publish the site.

The existing build writes the validated public dataset and complete selected GM generation into `dist/`. Pages uses the separate `wrangler.pages.jsonc` configuration with `pages_build_output_dir` set to `./dist`. No Functions or Worker script is needed.

```sh
npm ci
npm test
npm run build
npm run dev
```

Authenticate with the intended Cloudflare account before deployment. No credentials are committed. If the Pages project does not exist yet, create it once with the intended production branch:

```sh
npx wrangler whoami
npx wrangler pages project create tetizz-chess-friend-graph --production-branch main
```

To build and publish to the production branch:

```sh
npm run deploy -- --branch main
```

The deploy script builds `dist/` and runs `wrangler pages deploy dist --config wrangler.pages.jsonc --project-name tetizz-chess-friend-graph`. A direct-upload dashboard deployment must upload the contents of `dist/` to this Pages project. `npm run package` still creates a fresh verified ZIP and receipt in `verification/`, preserving prior packages and recording every included file's SHA-256. It verifies the selected GM closure and unpacked bytes, rejects unexpected files and symlinks, and excludes local selectors and credentials.

The build's `_headers` and root `404.html` are unchanged. Pages must serve the security headers, the dataset and release no-store rules, immutable GM assets, and the custom missing-page response. Pages provides native clean HTML redirects; after publication verify `/`, `/gm`, `/gm.html`, `/gm/`, an unknown route's 404 status, and the referenced GM assets before calling the migration live. Do not add an SPA fallback or wildcard redirect that hides missing data or pages.

The original Workers Static Assets configuration remains in `wrangler.jsonc`, including its `auto-trailing-slash` and `404-page` settings. `npm run dev:worker` and `npm run deploy:worker` retain that compatibility path; they are not the Pages release commands. The existing CI Worker dry run remains a compatibility check, not proof of a Pages deployment.

For a review build that preserves `dist/`, run `node scripts/build.mjs --output verification/<new-stage-name>`. Package that staged directory with the exported `packageSite({sourceDirectory, outputDirectory})` API.

Part of [tetizz chess lab](https://tetizz.github.io/Home/).
