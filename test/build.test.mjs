import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
test("isolated build pins GM selection, preserves main bytes and refuses stale outputs", async () => {
  const fixture = await mkdtemp(join(root, "test", ".build-fixture-"));
  try {
    for (const directory of ["scripts", "src", "public/data/gm"])
      await mkdir(join(fixture, directory), { recursive: true });
    for (const script of ["build.mjs", "package-site.mjs"])
      await copyFile(
        join(root, "scripts", script),
        join(fixture, "scripts", script),
      );
    const generation = "a".repeat(64),
      generatedAt = "2026-10-05T00:00:00Z";
    const base = join(fixture, "public/data/gm", generation);
    await mkdir(join(base, "friends"), { recursive: true });
    const summary = {
      status: "unknown",
      complete: false,
      enumeratedCount: 0,
      observedAt: null,
    };
    const index = {
      schemaVersion: 1,
      generation,
      generatedAt,
      accounts: [
        {
          username: "OneGM",
          title: "GM",
          profileUrl: "https://www.chess.com/member/OneGM",
          friendsUrl: "https://www.chess.com/member/OneGM/friends",
          friendCount: { value: null, display: null, precision: "unknown" },
          friendList: summary,
        },
      ],
      coverage: { completeLists: 0, partialLists: 0, unknownLists: 1 },
    };
    await writeFile(join(base, "index.json"), JSON.stringify(index));
    await writeFile(
      join(base, "friends/onegm.json"),
      JSON.stringify({
        schemaVersion: 1,
        generation,
        generatedAt,
        username: "OneGM",
        friendList: {
          ...summary,
          sourceUrl: null,
          displayedTotal: null,
          friends: [],
        },
      }),
    );
    await writeFile(
      join(fixture, "public/data/gm/current.json"),
      JSON.stringify({
        schemaVersion: 1,
        generation,
        baseGmGeneration: "b".repeat(64),
      }),
    );
    const data = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt,
        accounts: [{}],
        publication: { mainGeneration: "b".repeat(64) },
      }) + "\n",
    );
    const assets = new Map([
      ["index.html", "style.css app.mjs favicon.svg"],
      ["gm.html", "GM route"],
      ["public/favicon.svg", "<svg/>"],
      ["public/data/dataset.json", data],
      ...[
        "style.css",
        "app.mjs",
        "model.mjs",
        "chart.mjs",
        "gm-app.mjs",
        "gm-style.css",
      ].map((name) => [`src/${name}`, `fixture ${name}\n`]),
    ]);
    for (const [path, bytes] of assets)
      await writeFile(join(fixture, path), bytes);
    await run(process.execPath, [join(fixture, "scripts/build.mjs")]);
    assert.equal(
      JSON.parse(await readFile(join(fixture, "dist/release.json")))
        .gmGeneration,
      generation,
    );
    assert.equal(
      JSON.parse(await readFile(join(fixture, "dist/release.json")))
        .baseGmGeneration,
      "b".repeat(64),
    );
    assert.deepEqual(
      await readFile(join(fixture, "dist/data/dataset.json")),
      data,
    );
    for (const [source, target] of [
      ["src/app.mjs", "app.mjs"],
      ["src/style.css", "style.css"],
      ["src/model.mjs", "model.mjs"],
      ["src/chart.mjs", "chart.mjs"],
      ["index.html", "index.html"],
      ["public/favicon.svg", "favicon.svg"],
    ])
      assert.deepEqual(
        await readFile(join(fixture, "dist", target)),
        await readFile(join(fixture, source)),
      );
    await assert.rejects(readFile(join(fixture, "dist/data/gm/current.json")), {
      code: "ENOENT",
    });
    const staged = join(fixture, "verification", "joined-stage");
    await run(process.execPath, [
      join(fixture, "scripts/build.mjs"),
      "--output",
      staged,
    ]);
    assert.deepEqual(await readFile(join(staged, "data/dataset.json")), data);
    assert.deepEqual(
      await readFile(join(fixture, "dist/data/dataset.json")),
      data,
    );
    await mkdir(join(fixture, "dist/data/gm", "c".repeat(64)));
    await assert.rejects(
      run(process.execPath, [join(fixture, "scripts/build.mjs")]),
      /Unexpected build output/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
