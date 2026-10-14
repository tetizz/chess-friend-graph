import test from "node:test";
import assert from "node:assert/strict";
import * as app from "../src/gm-app.mjs";
const gen = "a".repeat(64),
  other = "b".repeat(64);
const account = {
  username: "ZeroGM",
  friendList: { status: "unknown", complete: false, enumeratedCount: 0 },
};
const payload = (g) => ({
  schemaVersion: 1,
  generation: g,
  username: "zerogm",
  friendList: { ...account.friendList, friends: [] },
});
test("validated immutable lists coalesce and cache by generation with bounded retention", async () => {
  assert.equal(typeof app.createFriendLoader, "function");
  let calls = 0,
    options = [];
  const load = app.createFriendLoader(async (url, init) => {
    calls++;
    options.push(init);
    return {
      ok: true,
      json: async () => payload(url.includes(other) ? other : gen),
    };
  }, 2);
  await Promise.all([load(account, gen), load(account, gen)]);
  for (let i = 0; i < 10; i++) await load(account, gen);
  assert.equal(calls, 1);
  await load(account, other);
  assert.equal(calls, 2);
  assert.equal(options[0].cache, "default");
});
test("invalid publication identity is rejected and never cached", async () => {
  assert.equal(typeof app.createFriendLoader, "function");
  let calls = 0;
  const load = app.createFriendLoader(async () => ({
    ok: true,
    json: async () => {
      calls++;
      return payload(other);
    },
  }));
  await assert.rejects(load(account, gen));
  await assert.rejects(load(account, gen));
  assert.equal(calls, 2);
  await assert.rejects(load(account, "../current"));
});
test("mutable pointers stay uncached while exact generation paths use browser cache", async () => {
  const options = [];
  const fetcher = async (url, init) => {
    options.push(init.cache);
    return { ok: true, json: async () => ({}) };
  };
  await app.fetchJson("./release.json", fetcher);
  await app.fetchJson(`./data/gm/${gen}/index.json`, fetcher);
  await app.fetchJson(`https://evil.test/data/gm/${gen}/index.json`, fetcher);
  assert.deepEqual(options, ["no-store", "default", "no-store"]);
});
test("bounded cache evicts old entries and refetches without mixing identities", async () => {
  let calls = 0;
  const load = app.createFriendLoader(async (url) => {
    calls++;
    const username = url.split("/").at(-1).replace(".json", "");
    return { ok: true, json: async () => ({ ...payload(gen), username }) };
  }, 2);
  for (const username of ["a", "b", "c", "a"])
    await load({ ...account, username }, gen);
  assert.equal(calls, 4);
});
