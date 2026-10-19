import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCarouselRouter } from '../routes/carousel.js';

const source = (id, accountId = null) => ({ id, projectId: 'ttchop2', userId: 'alice', accountId, createdAt: 1, slides: [{ index: 9, text: 'source', imagePrompt: 'p', bg: { status: 'done', url: 'https://fresh/image.jpg', storagePath: 'fresh/image.jpg' } }] });
async function setup(t, { matcher } = {}) {
  const calls = [], docs = new Map(), candidates = [source('candidate'), source('other-account', 'shop')];
  const deps = {
    configuredProjects: () => ['ttchop2'], verifyIdToken: async token => { if (token !== 'valid-alice') throw Error('invalid'); return { uid: 'alice' }; },
    getCarousel: async (p, id) => docs.get(id), listCarousels: async (p, uid) => { calls.push(['list', p, uid]); return [...docs.values(), ...candidates]; },
    createCarousel: async (p, c) => { c.createdAt = 2; docs.set(c.id, c); },
    updateCarousel: async (p, id, patch) => docs.set(id, { ...docs.get(id), ...patch }),
    generateSlides: async () => ({ slides: [{ index: 0, text: 'original 0', imagePrompt: 'prompt 0' }, { index: 1, text: 'original 1', imagePrompt: 'prompt 1' }], caption: 'original caption' }),
    matchBackgrounds: async args => { calls.push(['match', args]); return matcher ? matcher(args) : { matches: [{ targetSlideIndex: 0, sourceCarouselId: 'candidate', sourceSlideIndex: 9, url: 'https://fresh/image.jpg', storagePath: 'fresh/image.jpg' }], unmatchedSlideIndices: [1] }; },
    submitImageBatches: async args => calls.push(['kie', args]),
    triggerComposition: async args => calls.push(['compose', args]),
    getTemplateById: async (p, id) => ({ id, userId: 'alice', accountId: null, type: id.startsWith('style') ? 'carousel_style' : 'carousel_script', content: 'script format', visualBible: 'visual' }),
    getAccount: async (p, id) => id === 'alice_shop' ? { userId: 'alice', openId: 'shop' } : null,
  };
  const app = express(); app.use(express.json()); app.use('/carousel', createCarouselRouter(deps));
  const server = app.listen(0); t.after(() => server.close());
  const request = async (method, path, body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/carousel${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-alice' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ userId: 'alice', ...body }) }) }); return { status: r.status, body: await r.json() }; };
  return { request, calls, docs };
}
const inline = { projectId: 'ttchop2', script: 'script', language: 'es', scriptTemplate: { content: 'structure' }, styleTemplate: { visualBible: 'style' }, reuseBackgrounds: true };
const create = (extra = {}) => ({ ...inline, dryRun: false, ...extra });

test('manual partial reuse matches edited text/caption and submits only unmatched slide index', async t => {
  const { request, calls, docs } = await setup(t);
  const created = await request('POST', '/create', create());
  const id = created.body.carouselId;
  const approved = await request('POST', `/${id}/approve-text`, { projectId: 'ttchop2', slides: [{ index: 0, text: 'edited!', imagePrompt: 'edited scene' }], caption: 'edited caption' });
  assert.equal(approved.status, 200);
  const args = calls.find(c => c[0] === 'match')[1];
  assert.equal(args.targetCarousel.caption, 'edited caption');
  assert.equal(args.targetSlides[0].text, 'edited!');
  assert.deepEqual(calls.find(c => c[0] === 'kie')[1].targetSlides.map(s => s.index), [1]);
  assert.deepEqual(docs.get(id).slides[0].bg, { status: 'done', url: 'https://fresh/image.jpg', storagePath: 'fresh/image.jpg' });
});

test('full reuse composes once and does not submit to Kie', async t => {
 const { request, calls } = await setup(t, { matcher: async () => ({ matches: [{ targetSlideIndex: 0, sourceCarouselId: 'candidate', sourceSlideIndex: 9, url: 'fresh' }, { targetSlideIndex: 1, sourceCarouselId: 'candidate', sourceSlideIndex: 9, url: 'fresh' }], unmatchedSlideIndices: [] }) });
 const c = await request('POST', '/create', create());
 await request('POST', `/${c.body.carouselId}/approve-text`, { projectId: 'ttchop2' });
 assert.equal(calls.filter(x => x[0] === 'compose').length, 1);
 assert.equal(calls.filter(x => x[0] === 'kie').length, 0);
});

test('disabled reuse skips candidate listing and matcher', async t => {
 const { request, calls } = await setup(t);
 await request('POST', '/create', create({ reuseBackgrounds: false, autoApprove: true }));
 assert.equal(calls.some(x => x[0] === 'list' || x[0] === 'match'), false);
 assert.equal(calls.some(x => x[0] === 'kie'), true);
});

test('autoApprove uses the same reuse path and candidates are account scoped', async t => {
 const { request, calls } = await setup(t);
 await request('POST', '/create', create({ accountId: 'shop', autoApprove: true }));
 const args = calls.find(x => x[0] === 'match')[1];
 assert.deepEqual(args.trustedCandidates.map(c => c.id), ['other-account']);
 assert.equal(calls.some(x => x[0] === 'kie'), true);
});

test('invalid or deleted reuse results become unmatched and go to Kie', async t => {
 const { request, calls } = await setup(t, { matcher: async () => ({ matches: [], unmatchedSlideIndices: [0, 1] }) });
 const c = await request('POST', '/create', create({ autoApprove: true }));
 assert.equal(c.status, 200);
 assert.deepEqual(calls.find(x => x[0] === 'kie')[1].targetSlides.map(s => s.index), [0, 1]);
});
