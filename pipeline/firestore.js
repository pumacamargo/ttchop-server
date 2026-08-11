import { getDb } from './firebase.js';

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
  // A qué proyecto (ttchop / ttchop2) escribir. Ausente o desconocido → default.
  projectId = null,
}) {
  const db = getDb(projectId);
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

  // Keep scheduled_render in sync when a final status is reached
  if (status === 'done' || status === 'failed') {
    syncScheduledRenderStatus(db, taskId, status).catch(() => {});
  }
}

async function syncScheduledRenderStatus(db, renderId, status) {
  const snap = await db.collection('scheduled_renders')
    .where('renderId', '==', renderId)
    .limit(1)
    .get();
  if (!snap.empty) {
    await snap.docs[0].ref.update({ status });
  }
}
