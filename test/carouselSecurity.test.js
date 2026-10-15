import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCarouselRouter } from '../routes/carousel.js';

const base = { id: 'car1', userId: 'alice', projectId: 'ttchop2', accountId: null, status: 'text_review', slides: [{ index: 0, text: 'a', bg: { status: 'none' } }], scriptTemplate: { snapshot: {} }, styleTemplate: { snapshot: {} } };
async function fixture(t, overrides = {}) {
  const calls = [];
  const docs = new Map([['car1', { ...base }]]);
  const dependencies = {
    configuredProjects: () => ['ttchop2'],
    getCarousel: async (p, id) => { calls.push(['get', p, id]); return docs.get(id); },
    listCarousels: async (p, uid) => { calls.push(['list', p, uid]); return [...docs.values()]; },
    getTemplateById: async (p, id) => { calls.push(['template', p, id]); return { id, userId: id === 'foreign' ? 'bob' : 'alice', accountId: id === 'accountOnly' ? 'shop' : null, type: id.startsWith('style') ? 'carousel_style' : 'carousel_script', content: 'content', visualBible: 'visual' }; },
    getAccount: async (p, id) => { calls.push(['account', p, id]); return id === 'alice_shop' ? { userId: 'alice', openId: 'shop' } : { userId: 'bob', openId: 'shop' }; },
    createCarousel: async (p, carousel) => { calls.push(['create', p]); docs.set(carousel.id, carousel); },
    updateCarousel: async (p, id, patch) => { calls.push(['update', p]); docs.set(id, { ...docs.get(id), ...patch }); },
    deleteCarousel: async (p, id) => { calls.push(['delete', p]); docs.delete(id); },
    generateSlides: async () => ({ slides: [{ index: 0, text: 'new', imagePrompt: 'photo' }], caption: '' }),
    submitImageBatches: async () => { calls.push(['submit']); },
    triggerComposition: async () => { calls.push(['compose']); },
    resolveKieTask: async () => ({ resolved: true }),
  };
  const app = express(); app.use(express.json()); app.use('/carousel', createCarouselRouter({ ...dependencies, ...overrides }));
  const server = app.listen(0); t.after(() => server.close());
  const request = async (method, path, userId = 'alice', body = {}) => {
    const url = new URL(`http://127.0.0.1:${server.address().port}/carousel${path}`);
    if (method === 'GET' && userId) url.searchParams.set('userId', userId);
    const response = await fetch(url, {
      method, signal: AbortSignal.timeout(2000), headers: { 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(path.startsWith('/callback') ? body : { ...(userId ? { userId } : {}), ...body }) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls, docs };
}
const create = { projectId: 'ttchop2', userId: 'alice', script: 'hello', language: 'es', scriptTemplateId: 'script1', styleTemplateId: 'style1', dryRun: true };
test('GET identifies caller from query without Firebase Bearer', async t => {
  const { docs } = await fixture(t);
  const app = express();
  app.use('/carousel', createCarouselRouter({ configuredProjects: () => ['ttchop2'], getCarousel: async (p, id) => docs.get(id) }));
  const server = app.listen(0); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/carousel/car1?projectId=ttchop2&userId=alice`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).carousel.userId, 'alice');
});
test('create uses body userId and rejects foreign template/account before writes', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('POST', '/create', 'alice', { ...create, scriptTemplateId: 'foreign' })).status, 404);
  assert.equal((await request('POST', '/create', 'alice', { ...create, accountId: 'bob_shop' })).status, 403);
  assert.equal((await request('POST', '/create', 'alice', { ...create, accountId: 'shop' })).status, 200);
  const ok = await request('POST', '/create', 'alice', create);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.carousel.userId, 'alice');
  assert.equal(ok.body.carousel.callbackToken, undefined);
  assert.ok(calls.some(c => c[0] === 'create'));
});
test('POST uses body userId even if query suggests another user', async t => {
  const { request, docs } = await fixture(t);
  const response = await request('POST', '/create?userId=alice', 'alice', {
    projectId: 'ttchop2', userId: 'bob', script: 'hello', language: 'es', dryRun: true,
    scriptTemplate: { content: 'structure' }, styleTemplate: { visualBible: 'visual' },
  });
  assert.equal(response.status, 200);
  assert.equal(docs.get(response.body.carouselId).userId, 'bob');
});

test('account-specific templates cannot be selected from the general container', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('POST', '/create', 'alice', { ...create, scriptTemplateId: 'accountOnly' })).status, 404);
  assert.equal((await request('POST', '/create', 'alice', { ...create, accountId: 'shop', scriptTemplateId: 'accountOnly' })).status, 200);
});

test('account lookup failure is a controlled error', async t => {
  const { request } = await fixture(t, { getAccount: async () => { throw Error('db unavailable'); } });
  assert.equal((await request('POST', '/create', 'alice', { ...create, accountId: 'shop' })).status, 500);
});

test('client routes reject missing userId and wrong project without datastore lookup', async t => {
  const { request, calls } = await fixture(t);
  for (const [method, path, body] of [['GET','/car1?projectId=ttchop', null], ['POST','/create', { ...create, projectId: 'ttchop' }], ['POST','/car1/approve-text',{projectId:'ttchop'}], ['POST','/car1/regenerate',{projectId:'ttchop',slots:[0]}], ['POST','/car1/recompose',{projectId:'ttchop'}], ['DELETE','/car1',{projectId:'ttchop'}]]) {
    assert.equal((await request(method, path, 'alice', body)).status, 400);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request('GET', '/car1?projectId=ttchop2', '')).status, 400);
  assert.equal((await request('POST', '/create', '', { ...create, userId: '' })).status, 400);
  assert.equal((await request('POST', '/create', '', { ...create, userId: ['alice'] })).status, 400);
  assert.deepEqual(calls, []);
});
test('unconfigured ttchop2 stops requests before datastore access', async t => {
  const { request, calls } = await fixture(t, { configuredProjects: () => [] });
  assert.equal((await request('GET', '/car1?projectId=ttchop2')).status, 503);
  assert.equal((await request('POST', '/create', 'alice', create)).status, 503);
  assert.deepEqual(calls, []);
});

test('read approve regenerate recompose delete scope to supplied user and account', async t => {
  const { request, calls } = await fixture(t);
  for (const [method, path, body] of [['GET','/car1?projectId=ttchop2&accountId=shop'], ['POST','/car1/approve-text',{projectId:'ttchop2',accountId:'shop'}], ['POST','/car1/regenerate',{projectId:'ttchop2',accountId:'shop',slots:[0]}], ['POST','/car1/recompose',{projectId:'ttchop2',accountId:'shop'}], ['DELETE','/car1',{projectId:'ttchop2',accountId:'shop'}]]) {
    assert.equal((await request(method, path, 'bob', body)).status, 404);
    assert.equal((await request(method, path, 'alice', body)).status, 404);
  }
  assert.ok(!calls.some(c => ['update','delete','submit','compose'].includes(c[0])));
});
test('list excludes foreign user, foreign account, and callback secrets', async t => {
  const { request, docs, calls } = await fixture(t);
  docs.get('car1').callbackToken = 'secret';
  docs.set('car2', { ...base, id: 'car2', accountId: 'shop' });
  docs.set('car3', { ...base, id: 'car3', userId: 'bob' });
  docs.set('car4', { ...base, id: 'car4', projectId: 'ttchop' });
  const general = await request('GET', '?projectId=ttchop2');
  assert.deepEqual(general.body.carousels.map(c => c.id), ['car1']);
  assert.equal(general.body.carousels[0].callbackToken, undefined);
  const shop = await request('GET', '?projectId=ttchop2&accountId=shop');
  assert.deepEqual(shop.body.carousels.map(c => c.id), ['car2']);
  assert.deepEqual(calls.filter(c => c[0] === 'list'), [['list', 'ttchop2', 'alice'], ['list', 'ttchop2', 'alice']]);
});

test('callback never logs or returns its secret even on upstream failure', async t => {
  const { request, docs } = await fixture(t, { resolveKieTask: async () => { throw Error('callback?t=secret'); } });
  docs.get('car1').callbackToken = 'secret';
  const errors = [];
  const prior = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = prior; });
  const response = await request('POST', '/callback?c=car1&p=ttchop2&slot=0&t=secret', '', { taskId: 'task' });
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(response.body) + errors.join(' '), /secret/);
});

test('owned general routes and delete work, callback stays token-gated without Firebase auth', async t => {
  const { request, docs } = await fixture(t);
  docs.get('car1').callbackToken = 'secret';
  assert.equal((await request('GET','/car1?projectId=ttchop2')).body.carousel.callbackToken, undefined);
  assert.equal((await request('POST','/car1/regenerate','alice',{projectId:'ttchop2',slots:[0],what:'text'})).status, 200);
  assert.equal((await request('POST','/car1/recompose','alice',{projectId:'ttchop2'})).status, 200);
  assert.equal((await request('POST','/car1/approve-text','alice',{projectId:'ttchop2'})).status, 200);
  assert.equal((await request('POST','/callback?c=car1&p=ttchop&slot=0&t=secret','',{taskId:'task'})).status, 400);
  assert.equal((await request('POST','/callback?c=car1&p=ttchop2&slot=0&t=wrong','',{taskId:'task'})).status, 401);
  assert.equal((await request('POST','/callback?c=car1&p=ttchop2&slot=0&t=secret','',{taskId:'task'})).status, 200);
  assert.equal((await request('DELETE','/car1','alice',{projectId:'ttchop2'})).status, 200);
});

test("create stores reuseBackgrounds false by default", async t => {
 const { request, docs } = await fixture(t);
 const r = await request("POST", "/create", "alice", create);
 assert.equal(r.status, 200);
 assert.equal(docs.get(r.body.carouselId).reuseBackgrounds, false);
});
test('default slide generator uses injected callLLMJson', async t => {
  let calls = 0;
  const { request } = await fixture(t, { generateSlides: undefined, callLLMJson: async () => {
    calls++;
    return { slides: [{ index: 0, role: 'hook', text: 'hola', imagePrompt: 'photo' }], caption: 'caption', hashtags: [] };
  }});
  const response = await request('POST', '/create', 'alice', { ...create, dryRun: true });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.body.carousel.slides[0].text, 'hola');
});
