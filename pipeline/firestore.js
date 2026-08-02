import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db = null;

function getDb() {
  if (db) return db;

  if (getApps().length === 0) {
    let credential;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      credential = cert(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } else {
      throw new Error('No Firebase credentials configured (FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH)');
    }

    initializeApp({ credential });
  }

  db = getFirestore();
  return db;
}

export async function upsertRender({ taskId, status, videoUrl = null, errorMessage = null }) {
  const db = getDb();
  const ref = db.collection('renders').doc(taskId);
  await ref.set(
    {
      taskId,
      status,
      videoUrl,
      ...(errorMessage && { errorMessage }),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}
