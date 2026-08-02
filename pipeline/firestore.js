import { getFirestore } from 'firebase-admin/firestore';
import { ensureFirebase } from './firebase.js';

export async function upsertRender({
  taskId,
  status,
  videoUrl = null,
  errorMessage = null,
  // Campos opcionales para que el render aparezca correctamente en la webapp
  type = null,
  productId = null,
  productName = null,
  userId = null,
}) {
  ensureFirebase();
  const db = getFirestore();
  const ref = db.collection('renders').doc(taskId);

  const now = new Date().toISOString();
  const data = {
    taskId,
    id: taskId,
    status,
    videoUrl,
    updatedAt: now,
    ...(errorMessage && { errorMessage }),
    ...(type && { type }),
    ...(productId && { productId }),
    ...(productName && { productName }),
    ...(userId && { userId }),
  };

  const snap = await ref.get();
  if (!snap.exists) {
    data.createdAt = now;
  }

  await ref.set(data, { merge: true });
}
