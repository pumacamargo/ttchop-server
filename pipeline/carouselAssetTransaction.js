import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const COLLECTION = 'background_assets';

function normalizeAccountId(accountId) {
  return accountId == null || accountId === '' ? null : accountId;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid carousel asset record');
  if (record.projectId !== 'ttchop2') throw new Error('Carousel assets require project ttchop2');
  for (const field of ['userId', 'sourceCarouselId', 'sourceTaskId', 'url', 'storagePath', 'imageModel', 'prompt']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error(`Carousel asset requires ${field}`);
  }
  if (!Number.isInteger(record.sourceSlideIndex) || record.sourceSlideIndex < 0) throw new Error('Carousel asset requires a valid sourceSlideIndex');
  if (record.accountId != null && typeof record.accountId !== 'string') throw new Error('Invalid carousel asset accountId');
}

export function carouselAssetDocumentId(record) {
  const identity = [record.projectId, record.userId, normalizeAccountId(record.accountId), record.sourceCarouselId, record.sourceTaskId, record.sourceSlideIndex];
  return `carousel_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export async function stageCarouselAssetWrites(tx, db, records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('Carousel asset records must be a non-empty array');

  const unique = new Map();
  let scope;
  for (const record of records) {
    validateRecord(record);
    const normalizedAccountId = normalizeAccountId(record.accountId);
    const currentScope = [record.projectId, record.userId, normalizedAccountId];
    if (scope && !isDeepStrictEqual(scope, currentScope)) throw new Error('Carousel asset records must share one scope');
    scope ??= currentScope;
    const value = { ...record, accountId: normalizedAccountId };
    const id = carouselAssetDocumentId(value);
    if (unique.has(id) && !isDeepStrictEqual(unique.get(id).value, value)) throw new Error('Carousel asset identity conflict within batch');
    unique.set(id, { value });
  }

  const entries = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));
  const refs = entries.map(([id]) => db.collection(COLLECTION).doc(id));
  const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));

  for (let i = 0; i < entries.length; i++) {
    const [id, { value }] = entries[i];
    const snapshot = snapshots[i];
    if (snapshot.exists && !isDeepStrictEqual(snapshot.data(), value)) throw new Error(`Carousel asset conflict for ${id}`);
  }

  for (let i = 0; i < entries.length; i++) {
    if (!snapshots[i].exists) tx.set(refs[i], entries[i][1].value);
  }
  return entries.map(([id]) => id);
}
