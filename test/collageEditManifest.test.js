import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollageEditManifest, attachCollageMeasurements } from '../pipeline/collageEditManifest.js';
import { writeRender } from '../pipeline/firestore.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

const sessions = [
  { id: 'sess-a', videos: [{ id: 'hook', downloadUrl: 'https://x?token=secret' }, { id: 'body_ext9', downloadUrl: 'https://y?token=secret' }] },
  { id: 'sess-b', videos: [{ id: 'other', downloadUrl: 'https://z?token=secret' }] },
];
const clips = [
  { clipId: 'hook', role: 'hook', trimStart: 1, trimEnd: 3, speed: 2, firebaseUrl: 'https://x?token=secret', src: '/tmp/private/audio.mp3' },
  // After the route's trim clamp (the original end was outside the source).
  { clipId: 'body_ext9', role: 'body', trimStart: 2, trimEnd: 6.5, speed: 1.5, firebaseUrl: 'https://y?token=secret' },
  { clipId: 'other', role: 'body', trimStart: 0, trimEnd: 3, speed: 1.5 },
  { clipId: 'body_ext9_ext1', role: 'body', trimStart: 2, trimEnd: 5, speed: 1.5, firebaseUrl: 'https://y?token=secret' },
];

test('final corrected recipe: hook/body speeds, clamped trim, filler provenance and concat order', () => {
  const m = createCollageEditManifest(clips, sessions, 8, 3);
  assert.equal(m.version, 1);
  near(m.plannedVideoDurationSeconds, 8);
  assert.deepEqual(m.segments.map(s => [s.index, s.recipeIndex, s.sessionId, s.sourceClipId, s.role, s.repeated]), [
    [0, 0, 'sess-a', 'hook', 'hook', false],
    [1, 1, 'sess-a', 'body_ext9', 'body', false],
    [2, 2, 'sess-b', 'other', 'body', false],
    [3, 3, 'sess-a', 'body_ext9', 'body', true],
  ]);
  [0, 1, 4, 6, 8].forEach((expected, i) => {
    const actual = i === 4 ? m.segments[3].timelineEndSeconds : m.segments[i].timelineStartSeconds;
    near(actual, expected);
  });
  near(m.segments[1].sourceEndSeconds, 6.5);
  near(m.segments[3].sourceEndSeconds, 5);
  assert.equal(m.segments[3].speed, 1.5);
  near(m.segments[3].outputDurationSeconds, 2);
  const serialized = JSON.stringify(m);
  for (const forbidden of ['token', 'https:', '/tmp/', 'secret', 'firebaseUrl', 'src']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('audio -shortest caps last visible interval; nonpositive trims are skipped like builder', () => {
  const m = createCollageEditManifest([
    { clipId: 'hook', trimStart: 0, trimEnd: 0, speed: 1 },
    { clipId: 'body_ext9', role: 'body', trimStart: 2, trimEnd: 6.5, speed: 1.5 },
  ], sessions, 2, 2);
  assert.equal(m.segments.length, 1);
  assert.equal(m.segments[0].recipeIndex, 1);
  near(m.segments[0].sourceEndSeconds, 5);
  near(m.plannedVideoDurationSeconds, 3);
  assert.equal(m.plannedTimelineDurationSeconds, 2);
});

test('unknown or ambiguous source cannot silently fabricate provenance', () => {
  assert.throws(() => createCollageEditManifest([{ clipId: 'invented', trimStart: 0, trimEnd: 1 }], sessions, 1), /Unknown source/);
  assert.throws(() => createCollageEditManifest([{ clipId: 'hook', trimStart: 0, trimEnd: 1 }], [...sessions, { id: 'duplicate', videos: [{ id: 'hook' }] }], 1), /Ambiguous/);
  assert.throws(() => createCollageEditManifest(clips, [{ id: 'https://signed?token=secret', videos: [{ id: 'hook' }] }], 8), /Unsafe/);
});

function fakeDb() {
  const doc = { value: null };
  const ref = {
    async get() { return { exists: doc.value !== null }; },
    async set(data) { doc.value = { ...(doc.value || {}), ...structuredClone(data) }; },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const parts = path.split('.');
        let target = doc.value;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        target[parts.at(-1)] = structuredClone(value);
      }
    },
  };
  return { doc, db: { collection(name) { if (name === 'scheduled_renders') return { where() { return { limit() { return { async get() { return { empty: true }; } }; } }; } }; assert.equal(name, 'renders'); return { doc(id) { assert.equal(id, 'render-1'); return ref; } }; } } };
}

test('Firestore stage/URL/status updates preserve manifest, including after failure', async () => {
  const { doc, db } = fakeDb();
  const manifest = createCollageEditManifest(clips, sessions, 8, 3);
  await writeRender(db, { taskId: 'render-1', status: 'pending', inputs: { collage: { sessions } } });
  await writeRender(db, { taskId: 'render-1', status: 'processing', inputs: { collage: { editManifest: manifest } } });
  await writeRender(db, { taskId: 'render-1', status: 'processing', videoUrl: 'https://result', inputs: { collage: { videoUrl: 'https://result' } } });
  assert.deepEqual(doc.value.inputs.collage.editManifest, manifest);
  assert.deepEqual(doc.value.inputs.collage.sessions, sessions);
  assert.equal(doc.value.videoUrl, 'https://result');
  await writeRender(db, { taskId: 'render-1', status: 'done', inputs: { collage: { voiceId: 'voice' } } });
  await writeRender(db, { taskId: 'render-1', status: 'failed' });
  assert.deepEqual(doc.value.inputs.collage.editManifest, manifest);
  assert.equal(doc.value.inputs.collage.voiceId, 'voice');
});

test('builder ffprobe measurements are separate from planned offsets and final MP4 duration', () => {
  const m = createCollageEditManifest(clips, sessions, 8, 3);
  const measured = attachCollageMeasurements(m, [
    { recipeIndex: 0, measuredDurationSeconds: 1.04 },
    { recipeIndex: 1, measuredDurationSeconds: 3.04 },
    { recipeIndex: 2, measuredDurationSeconds: 2.04 },
    { recipeIndex: 3, measuredDurationSeconds: 2.04 },
  ], 7.98);
  assert.equal(measured.actualMp4DurationSeconds, 7.98);
  assert.equal(measured.segments[1].timelineStartSeconds, 1);
  assert.equal(measured.measuredVideoSegments[1].timelineStartSeconds, 1.04);
  near(measured.measuredVideoSegments[3].timelineEndSeconds, 7.98);
  assert.equal(measured.measuredVideoSegments[3].sourceClipId, 'body_ext9');
  assert.equal(m.actualMp4DurationSeconds, undefined);
});

test('keeps positive clips after planned audio cutoff for measured-video provenance', () => {
  const m = createCollageEditManifest(clips, sessions, 2, 3);
  assert.equal(m.segments.length, 4);
  assert.equal(m.segments[3].outputDurationSeconds, 0);
  const measured = attachCollageMeasurements(m, [
    { recipeIndex: 0, measuredDurationSeconds: 0.5 },
    { recipeIndex: 1, measuredDurationSeconds: 0.5 },
    { recipeIndex: 2, measuredDurationSeconds: 0.5 },
    { recipeIndex: 3, measuredDurationSeconds: 0.5 },
  ], 2);
  assert.equal(measured.measuredVideoSegments[3].sourceClipId, 'body_ext9');
});
