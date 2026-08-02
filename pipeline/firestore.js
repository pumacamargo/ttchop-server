import { getFirestore } from 'firebase-admin/firestore';
import { ensureFirebase } from './firebase.js';

export async function upsertRender({ taskId, status, videoUrl = null, errorMessage = null }) {
  ensureFirebase();
  const db = getFirestore();
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
