import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completeBackgroundTask } from '../pipeline/carouselStore.js';
import { resolveKieTask } from '../pipeline/carouselImages.js';
const attr = (task, slots, slot) => ({ taskId: task, slots, slot, prompt: `FULL ${task}`, imagePrompts: slots.map(index => ({ index, imagePrompt: `prompt ${index}` })) });
const s = (index, task, bg = {}) => ({ index, bg: { taskId: task, status: 'pending', attempts: 1, ...bg } });
const c = (slides, task = 't', slot = 'batch', slots = slides.map(x => x.index)) => ({ id: 'c', projectId: 'ttchop2', userId: 'u', accountId: null, status: 'generating_images', imageModel: 'seedream-v4', slides, imageTaskPrompts: { [task]: attr(task, slots, slot) } });
function fakeDb(data) {
  const docs = new Map([['carousels/c', structuredClone(data)]]), events = [];
  let commits = 0;
  return { docs, events, get commits() { return commits; }, get data() { return docs.get('carousels/c'); }, get assets() { return [...docs].filter(([key]) => key.startsWith('background_assets/')); },
    collection: name => ({ doc: id => ({ id, key: `${name}/${id}` }) }),
    runTransaction: async fn => { const writes = []; const tx = {
      get: async ref => { events.push(['get', ref.key]); return { exists: docs.has(ref.key), data: () => structuredClone(docs.get(ref.key)) }; },
      set: (ref, value, opts) => { events.push(['set', ref.key]); writes.push([ref.key, structuredClone(value), opts]); },
    }; const result = await fn(tx); for (const [key, value, opts] of writes) docs.set(key, opts?.merge ? { ...docs.get(key), ...value } : value); if (writes.length) commits++; return result; },
  };
}
const payload = (slot, urls = ['url'], storagePaths = ['path']) => ({ taskId: 't', slot, urls, storagePaths });
test('single completion atomically stores background without asset collection or assetId', async () => {
  const db = fakeDb(c([s(3, 't')], 't', '3'));
  const result = await completeBackgroundTask('ttchop2', 'c', payload('3'), { db });
  assert.equal(result.startedComposing, true); assert.equal(db.data.status, 'composing'); assert.equal(db.commits, 1);
  assert.equal(db.assets.length, 0); assert.equal('assetId' in db.data.slides[0].bg, false);
  assert.deepEqual(db.data.slides[0].bg, { taskId: 't', status: 'done', attempts: 2, url: 'url', storagePath: 'path' });
  assert.equal(db.data.imageTaskPrompts.t.prompt, 'FULL t');
  const firstWrite = db.events.findIndex(([type]) => type === 'set');
  assert.ok(firstWrite > 0); assert.equal(db.events[0][0], 'get');
  assert.ok(db.events.slice(firstWrite).every(([type, key]) => type === 'set' && !key.startsWith('background_assets/')));
});
test('batch associates completed backgrounds by slots and indices', async () => {
  const db = fakeDb(c([s(8, 't'), s(2, 't')], 't', 'batch', [8, 2]));
  await completeBackgroundTask('ttchop2', 'c', payload('batch', ['u8', 'u2'], ['p8', 'p2']), { db });
  assert.equal(db.assets.length, 0);
  assert.deepEqual(db.data.slides.map(slide => [slide.index, slide.bg.url]), [[8, 'u8'], [2, 'u2']]);
  assert.ok(db.data.slides.every(slide => !('assetId' in slide.bg)));
});
test('stale single and partly displaced batch have zero writes', async () => {
  for (const [slides, slot, slots] of [[[s(0, 'new')], '0', [0]], [[s(0, 't'), s(1, 'new')], 'batch', [0, 1]]]) {
    const db = fakeDb(c(slides, 't', slot, slots)); const before = structuredClone(db.data);
    assert.deepEqual(await completeBackgroundTask('ttchop2', 'c', payload(slot, ['a', 'b'], ['p', 'q']), { db }), { ok: false, reason: 'stale_task' });
    assert.deepEqual(db.data, before); assert.equal(db.assets.length, 0); assert.equal(db.commits, 0);
  }
});
test('identical retry does not rewrite or recompose', async () => {
  const db = fakeDb(c([s(0, 't')], 't', '0')); await completeBackgroundTask('ttchop2', 'c', payload('0'), { db });
  const before = structuredClone([...db.docs]);
  const result = await completeBackgroundTask('ttchop2', 'c', payload('0'), { db });
  assert.equal(result.alreadyDone, true); assert.equal(result.startedComposing, false); assert.equal(db.commits, 1); assert.deepEqual([...db.docs], before);
});
test('legacy done background without assetId remains idempotent without network', async () => {
  const db = fakeDb(c([s(0, 't', { status: 'done', url: 'saved-url', storagePath: 'saved-path' })], 't', '0'));
  const before = structuredClone([...db.docs]);
  let network = 0, compositions = 0;
  const result = await resolveKieTask({ projectId: 'ttchop2', carouselId: 'c', taskId: 't', slot: '0' }, { db,
    getCarousel: async () => db.data, getTaskRecord: async () => { network++; throw Error('Kie'); },
    uploadFileToStorage: async () => { network++; throw Error('Storage'); }, triggerComposition: async () => { compositions++; },
  });
  assert.equal(result.result.alreadyDone, true); assert.equal(network, 0); assert.equal(compositions, 0);
  assert.equal(db.assets.length, 0); assert.equal(db.commits, 0); assert.deepEqual([...db.docs], before);
  assert.equal('assetId' in db.data.slides[0].bg, false);
});
test('invalid project is rejected before database acquisition', async () => {
  await assert.rejects(completeBackgroundTask('ttchop', 'c', payload('0')), /ttchop2/);
});
test('resolve maps result URLs to attribution order and immutable task-hash paths', async () => {
  const db = fakeDb(c([s(7, 't'), s(2, 't')], 't', 'batch', [7, 2]));
  const uploads = []; let kie = 0;
  const options = { db, getCarousel: async () => db.data, getTaskRecord: async () => { kie++; return { data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['kie-7', 'kie-2'] }) } }; }, downloadToTmp: async url => url,
    uploadFileToStorage: async (_local, path) => { uploads.push(path); return `stored:${path}`; }, triggerComposition: async () => {} };
  const result = await resolveKieTask({ projectId: 'ttchop2', carouselId: 'c', taskId: 't', slot: 'batch' }, options);
  assert.equal(result.result.ok, true);
  const h = createHash('sha256').update('t').digest('hex');
  assert.deepEqual(uploads, [7, 2].map(i => `carousels/c/bg/${h}/${i}.png`));
  assert.equal(db.data.slides[0].bg.url, `stored:${uploads[0]}`);
  await resolveKieTask({ projectId: 'ttchop2', carouselId: 'c', taskId: 't', slot: 'batch' }, options);
  assert.equal(kie, 1); assert.equal(uploads.length, 2);
});
test('partial displacement and wrong result count never upload', async () => {
  for (const displaced of [true, false]) {
    const db = fakeDb(c([s(0, 't'), s(1, displaced ? 'other' : 't')], 't', 'batch', [0, 1]));
    let kie = 0, uploads = 0;
    const result = await resolveKieTask({ projectId: 'ttchop2', carouselId: 'c', taskId: 't', slot: 'batch' }, { db, getCarousel: async () => db.data,
      getTaskRecord: async () => { kie++; return { data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['only-one'] }) } }; },
      downloadToTmp: async () => { uploads++; }, uploadFileToStorage: async () => { uploads++; } });
    assert.equal(uploads, 0); assert.equal(db.assets.length, 0);
    assert.equal(result.result.reason, displaced ? 'stale_task' : 'result_count_mismatch'); assert.equal(kie, displaced ? 0 : 1);
  }
});
test('failed Kie task does not persist untrusted text containing callback secret', async () => {
  const db = fakeDb(c([s(0, 't')], 't', '0'));
  const result = await resolveKieTask({ projectId: 'ttchop2', carouselId: 'c', taskId: 't', slot: '0' }, {
    db, getCarousel: async () => db.data,
    getTaskRecord: async () => ({ data: { state: 'fail', failMsg: 'callback?t=SECRET_CALLBACK_TOKEN' } }),
  });
  assert.equal(result.failed, true);
  assert.equal(db.data.slides[0].bg.status, 'failed');
  assert.doesNotMatch(JSON.stringify(db.data), /SECRET_CALLBACK_TOKEN/);
});

test('failure callback displaced after preflight remains read-only in transaction', async () => {
  const db = fakeDb(c([s(0, 't'), s(1, 't')], 't', 'batch', [0, 1]));
  const result = await resolveKieTask({ projectId: 'ttchop2', carouselId: 'c', taskId: 't', slot: 'batch' }, {
    db, getCarousel: async () => db.data,
    getTaskRecord: async () => { db.data.slides[1].bg.taskId = 'new'; return { data: { state: 'fail' } }; },
  });
  assert.equal(result.result.reason, 'stale_task'); assert.equal(db.data.slides[0].bg.status, 'pending'); assert.equal(db.commits, 0);
});

test('rejects carousel project mismatch without asset or slide writes', async () => {
  const data = c([s(0, 't')], 't', '0'); data.projectId = 'ttchop';
  const db = fakeDb(data); const before = structuredClone(db.data);
  await assert.rejects(completeBackgroundTask('ttchop2', 'c', payload('0'), { db }), /project/i);
  assert.deepEqual(db.data, before); assert.equal(db.assets.length, 0);
});
