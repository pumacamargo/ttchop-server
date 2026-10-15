import test from "node:test";
import assert from "node:assert/strict";
import { stageCarouselAssetWrites } from "../pipeline/carouselAssetTransaction.js";

const rec = (overrides = {}) => ({ projectId: "ttchop2", userId: "u1", sourceCarouselId: "c1", sourceTaskId: "task1", sourceSlideIndex: 0, accountId: null, url: "https://asset", storagePath: "assets/a", imageModel: "model", prompt: "original prompt", ...overrides });
function fakeDb(existing = {}) {
  const writes = [], events = [];
  const tx = { get: async ref => { events.push(["get", ref.id]); return { exists: Object.hasOwn(existing, ref.id), data: () => existing[ref.id] }; }, set: (ref, value) => { events.push(["set", ref.id]); writes.push([ref.id, value]); } };
  return { tx, db: { collection: name => ({ doc: id => ({ collection: name, id }) }) }, writes, events };
}

test("stages a deterministic multi-slide batch and deduplicates exact inputs", async () => {
  const f = fakeDb(); const records = [rec(), rec({ sourceSlideIndex: 1, url: "https://b", storagePath: "assets/b" })];
  const ids = await stageCarouselAssetWrites(f.tx, f.db, [records[1], records[0], records[0]]);
  assert.equal(ids.length, 2); assert.deepEqual(ids, [...ids].sort()); assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(([, value]) => value.projectId === "ttchop2"));
});

test("identical retry is idempotent and differing generations get different IDs", async () => {
  const first = fakeDb(); const record = rec(); const [id] = await stageCarouselAssetWrites(first.tx, first.db, [record]);
  const retry = fakeDb({ [id]: record }); assert.deepEqual(await stageCarouselAssetWrites(retry.tx, retry.db, [record]), [id]); assert.equal(retry.writes.length, 0);
  const generations = fakeDb(); const generated = await stageCarouselAssetWrites(generations.tx, generations.db, [record, rec({ sourceTaskId: "task2" })]); assert.notEqual(generated[0], generated[1]);
});

test("normalizes general account but isolates account IDs", async () => {
  const general = fakeDb(); const [generalId] = await stageCarouselAssetWrites(general.tx, general.db, [rec({ accountId: undefined })]);
  const account = fakeDb(); const [accountId] = await stageCarouselAssetWrites(account.tx, account.db, [rec({ accountId: "acct" })]);
  const normalized = fakeDb(); const [normalizedId] = await stageCarouselAssetWrites(normalized.tx, normalized.db, [rec({ accountId: "" })]);
  assert.notEqual(generalId, accountId); assert.equal(generalId, normalizedId);
});

test("rejects empty, invalid, incomplete, and mixed-scope batches before writes", async () => {
  for (const records of [[], [rec({ projectId: "ttchop" })], [rec({ userId: " " })], [rec({ prompt: undefined })], [rec(), rec({ userId: "u2" })], [rec(), rec({ accountId: "acct" })]]) {
    const f = fakeDb(); await assert.rejects(stageCarouselAssetWrites(f.tx, f.db, records)); assert.equal(f.writes.length, 0);
  }
});

test("conflict never overwrites and all reads precede every write", async () => {
  const records = [rec(), rec({ sourceSlideIndex: 1 })]; const f = fakeDb(); const ids = await stageCarouselAssetWrites(f.tx, f.db, records);
  assert.ok(Math.max(...f.events.map((e,i)=>e[0]==="get"?i:-1)) < Math.min(...f.events.map((e,i)=>e[0]==="set"?i:Infinity)));
  const conflict = fakeDb({ [ids[0]]: { ...records[0], prompt: "different" } }); await assert.rejects(stageCarouselAssetWrites(conflict.tx, conflict.db, records), /conflict/i); assert.equal(conflict.writes.length, 0);
});
