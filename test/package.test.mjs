import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import {
  createSiteZip,
  packageSite,
  SITE_ASSETS,
} from "../scripts/package-site.mjs";

async function fixture(run) {
  const workspace = await mkdtemp(join(tmpdir(), "chess-site-package-"));
  const directory = join(workspace, "dist");
  try {
    await mkdir(join(directory, "data"), { recursive: true });
    for (const name of SITE_ASSETS)
      await writeFile(
        join(directory, name),
        Buffer.from(`fixture:${name}\n\0`, "utf8"),
      );
    await run(directory, join(workspace, "verification"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
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

test("successive packages preserve older archives and bind receipts to every file", () =>
  fixture(async (sourceDirectory, outputDirectory) => {
    await mkdir(outputDirectory);
    const legacy = join(outputDirectory, "cloudflare-site.zip");
    await writeFile(legacy, "preserved legacy package");
    const first = await packageSite({ sourceDirectory, outputDirectory });
    const firstArchive = await readFile(first.output);
    const firstReceipt = await readFile(first.receipt);
    await writeFile(
      join(sourceDirectory, "data/dataset.json"),
      "next public dataset",
    );
    const second = await packageSite({ sourceDirectory, outputDirectory });
    assert.notEqual(second.output, first.output);
    assert.notEqual(second.receipt, first.receipt);
    assert.equal(await readFile(legacy, "utf8"), "preserved legacy package");
    assert.deepEqual(await readFile(first.output), firstArchive);
    assert.deepEqual(await readFile(first.receipt), firstReceipt);
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    for (const result of [first, second]) {
      const archive = await readFile(result.output);
      const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
      assert.equal(result.assets, SITE_ASSETS.length);
      assert.equal(result.bytes, archive.length);
      assert.equal(result.sha256, hash(archive));
      assert.equal(receipt.sha256, hash(archive));
      assert.equal(receipt.bytes, archive.length);
      assert.equal(receipt.output, result.output);
      const extracted = unzipSync(archive);
      assert.deepEqual(
        receipt.files.map((file) => file.path),
        SITE_ASSETS,
      );
      for (const file of receipt.files) {
        assert.equal(file.bytes, extracted[file.path].length);
        assert.equal(file.sha256, hash(extracted[file.path]));
      }
    }
    assert.notDeepEqual(await readFile(second.output), firstArchive);
  }));

test("unique output paths retain reproducible archive bytes for identical inputs", () =>
  fixture(async (sourceDirectory, outputDirectory) => {
    const first = await packageSite({ sourceDirectory, outputDirectory });
    const second = await packageSite({ sourceDirectory, outputDirectory });
    assert.notEqual(first.output, second.output);
    assert.deepEqual(
      await readFile(first.output),
      await readFile(second.output),
    );
    assert.equal(first.sha256, second.sha256);
  }));

test("an output path occupied by a file is refused without overwriting it", () =>
  fixture(async (sourceDirectory, outputDirectory) => {
    await writeFile(outputDirectory, "preserved output file");
    await assert.rejects(packageSite({ sourceDirectory, outputDirectory }));
    assert.equal(
      await readFile(outputDirectory, "utf8"),
      "preserved output file",
    );
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
