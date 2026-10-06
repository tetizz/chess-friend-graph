# Chess Friend Graph

Explore Chess.com’s titled players by rating and public friend count. Built in the same warm, dark style as the tetizz chess projects.

[Open the live site](https://chess-friend-graph.tetizz.workers.dev/).

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

## Cloudflare

This repository uses Workers Static Assets. The deployable files are built into `dist/`; the Worker configuration is in `wrangler.jsonc`.

```sh
npx wrangler whoami
npm run deploy
```

Authenticate with the intended Cloudflare account before deployment. No credentials are committed to this repository.

The current site was published with Cloudflare’s dashboard using **Upload your static files**. To prepare an update:

```sh
npm run package
```

Upload the ZIP at the printed `output` path through **New deployment** on the existing `chess-friend-graph` Worker. Each run creates a new archive and JSON receipt in `verification/`, preserving earlier packages. The receipt records SHA-256 hashes for the archive and every included file. The command packages the public site assets and selected GM generation, checks their sizes, and verifies their bytes after unpacking. It refuses unexpected files and symlinks. Identical inputs produce identical ZIP bytes; archive names and receipts are unique. Both stay out of Git. Dashboard uploads do not require granting Wrangler additional account access.

For a review build that preserves `dist/`, run `node scripts/build.mjs --output verification/<new-stage-name>`. Package that staged directory with the exported `packageSite({sourceDirectory, outputDirectory})` API.

Part of [tetizz chess lab](https://tetizz.github.io/Home/).
