import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createSiteZip, SITE_ASSETS } from "../scripts/package-site.mjs";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "chess-site-package-"));
  try {
    await mkdir(join(directory, "data"));
    for (const name of SITE_ASSETS)
      await writeFile(
        join(directory, name),
        Buffer.from(`fixture:${name}\n\0`, "utf8"),
      );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ZIP has exact root-relative filenames and preserves every byte reproducibly", () =>
  fixture(async (directory) => {
    const first = await createSiteZip(directory),
      second = await createSiteZip(directory);
    assert.deepEqual(first, second);
    const files = unzipSync(first);
    assert.deepEqual(Object.keys(files).sort(), [...SITE_ASSETS].sort());
    for (const name of SITE_ASSETS)
      assert.deepEqual(
        Buffer.from(files[name]),
        Buffer.from(`fixture:${name}\n\0`),
      );
    assert.ok(files["index.html"] && files["data/dataset.json"]);
  }));

test("missing assets and unexpected private files/directories are rejected", () =>
  fixture(async (directory) => {
    await rm(join(directory, "index.html"));
    await assert.rejects(createSiteZip(directory), /Missing deploy asset/);
    await writeFile(join(directory, "index.html"), "restored");
    await writeFile(join(directory, "private-evidence.json"), "private");
    await assert.rejects(createSiteZip(directory), /Unexpected deploy asset/);
    await rm(join(directory, "private-evidence.json"));
    await mkdir(join(directory, ".git"));
    await assert.rejects(
      createSiteZip(directory),
      /Unexpected deploy directory/,
    );
  }));

test("assets over 25 MiB are rejected before packaging", () =>
  fixture(async (directory) => {
    await truncate(join(directory, "app.mjs"), 25 * 1024 * 1024 + 1);
    await assert.rejects(createSiteZip(directory), /Oversized deploy asset/);
  }));

test("symlink assets are rejected", async (t) =>
  fixture(async (directory) => {
    await rm(join(directory, "app.mjs"));
    try {
      await symlink(join(directory, "model.mjs"), join(directory, "app.mjs"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("OS does not permit fixture symlinks");
        return;
      }
      throw error;
    }
    await assert.rejects(createSiteZip(directory), /Symlink deploy asset/);
  }));
