import test from 'node:test';
import assert from 'node:assert/strict';
import { planCarouselBackgroundBackfill } from '../scripts/planCarouselBackgroundBackfill.js';
const bg = (taskId, overrides = {}) => ({ status: 'done', taskId, storagePath: `images/${taskId}.jpg`, url: `https://${taskId}.jpg`, ...overrides });
const slide = (background, overrides = {}) => ({ bg: background, ...overrides });
const carousel = (id, slides, overrides = {}) => ({ id, projectId: 'ttchop2', userId: 'u1', slides, ...overrides });
const ref = (carouselId, slideIndex, taskId, extras = {}) => ({ projectId: 'ttchop2', userId: 'u1', accountId: null, carouselId, slideIndex, taskId, storagePath: `images/${taskId}.jpg`, url: `https://${taskId}.jpg`, prompt: null, ...extras });
test('general missing/null account and distinct empty account', () => {
 const result = planCarouselBackgroundBackfill([carousel('missing',[slide(bg('a'))]),carousel('nil',[slide(bg('b'))],{accountId:null}),carousel('empty',[slide(bg('c'))],{accountId:''}),carousel('acct',[slide(bg('d'))],{accountId:'account-1'})]);
 assert.deepEqual(result,[ref('empty',0,'c',{accountId:''}),ref('missing',0,'a'),ref('nil',0,'b'),ref('acct',0,'d',{accountId:'account-1'})]);
 assert.deepEqual(planCarouselBackgroundBackfill([carousel('missing',[slide(bg('a'))]),carousel('nil',[slide(bg('b'))],{accountId:null}),carousel('empty',[slide(bg('c'))],{accountId:''}),carousel('acct',[slide(bg('d'))],{accountId:'account-1'})].reverse()),result);
});
test('keeps users/accounts separate and includes multiple slides and batch entries', () => {
 const result=planCarouselBackgroundBackfill([carousel('z',[slide(bg('z0')),slide(bg('z1'))]),carousel('a',[slide(bg('a0'))],{userId:'u2',accountId:'account-1'}),carousel('b',[slide(bg('b0'))],{accountId:'account-1'})]);
 assert.deepEqual(result,[ref('z',0,'z0'),ref('z',1,'z1'),ref('b',0,'b0',{accountId:'account-1'}),ref('a',0,'a0',{userId:'u2',accountId:'account-1'})]);
 assert.deepEqual(planCarouselBackgroundBackfill([carousel('z',[slide(bg('z0')),slide(bg('z1'))]),carousel('a',[slide(bg('a0'))],{userId:'u2',accountId:'account-1'}),carousel('b',[slide(bg('b0'))],{accountId:'account-1'})].reverse()),result);
});
test('dedupes references and uses only attributed prompt', () => {
 const c=carousel('c',[slide(bg('task')),slide(bg('task')),slide(bg('other'),{imagePrompt:'DO NOT USE'})],{imageTaskPrompts:{task:{prompt:'complete task prompt'}}});
 assert.deepEqual(planCarouselBackgroundBackfill([c,c]),[ref('c',0,'task',{prompt:'complete task prompt'}),ref('c',1,'task',{prompt:'complete task prompt'}),ref('c',2,'other')]);
});
test('excludes pending, failed, incomplete, wrong project, final and ZIP', () => {
 const incomplete=bg('incomplete'); delete incomplete.storagePath;
 const c=carousel('c',[slide(bg('pending',{status:'pending'})),slide(bg('failed',{status:'failed'})),slide(incomplete),slide({status:'done',storagePath:'x',url:'u'}),{final:{status:'done',taskId:'final',storagePath:'f',url:'f'}},{zip:{status:'done',taskId:'zip',storagePath:'z',url:'z'}}]);
 assert.deepEqual(planCarouselBackgroundBackfill([c,carousel('legacy',[slide(bg('legacy'))],{projectId:'ttchop'})]),[]);
});
