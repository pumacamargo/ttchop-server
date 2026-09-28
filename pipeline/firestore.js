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
  // Personaje: guion (líneas con emoción+timing), URL del audio subido, y metadata
  // del render (voiceId, versión del .riv, mapeo de emociones, etc).
  script = null,
  audioUrl = null,
  characterMeta = null,
  // inputs: { collage?, overlay?, character? } — todo lo necesario para volver a
  // disparar esa etapa sola más adelante (solo con el renderId). Se guarda con
  // dot-notation (inputs.collage, inputs.overlay, inputs.character) para que cada
  // etapa se pueda actualizar sin borrar lo que ya guardaron las otras.
  inputs = null,
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
    ...(script && { script }),
    ...(audioUrl && { audioUrl }),
    ...(characterMeta && { characterMeta }),
  };

  const snap = await ref.get();
  if (!snap.exists) {
    data.createdAt = now;
  }

  await ref.set(data, { merge: true });

  // set(data, {merge:true}) trata una key con puntos como NOMBRE LITERAL del campo,
  // no como path anidado — solo update() interpreta dot-notation de verdad. Por eso
  // los inputs van en una llamada aparte, después de que el set() de arriba garantice
  // que el doc ya existe (update() falla en documentos inexistentes).
  if (inputs) {
    const inputUpdates = {};
    for (const stage of ['collage', 'overlay', 'character']) {
      // Firestore update() rechaza `undefined` como valor (incluso anidado) —
      // el round-trip por JSON lo elimina de los objetos (JSON.stringify omite
      // keys con valor undefined), dejando null/valores reales intactos.
      if (inputs[stage]) inputUpdates[`inputs.${stage}`] = JSON.parse(JSON.stringify(inputs[stage]));
    }
    if (Object.keys(inputUpdates).length > 0) {
      await ref.update(inputUpdates);
    }
  }

  // Keep scheduled_render in sync when a final status is reached
  if (status === 'done' || status === 'failed') {
    syncScheduledRenderStatus(db, taskId, status).catch(() => {});
  }
}

// Lee un render doc completo — usado para resumir/re-disparar una etapa dado solo
// el renderId (overlay o character leen aquí lo que la etapa anterior guardó en `inputs`).
export async function getRender(taskId, projectId = null) {
  const db = getDb(projectId);
  const snap = await db.collection('renders').doc(taskId).get();
  return snap.exists ? snap.data() : null;
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
