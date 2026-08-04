import { getStorage } from 'firebase-admin/storage';
import { ensureFirebase } from './firebase.js';
import { v4 as uuidv4 } from 'uuid';

export async function uploadToStorage(localPath, remoteFilename) {
  ensureFirebase();
  const bucket = getStorage().bucket();
  const destination = `collage/${remoteFilename}`;

  // Generar un download token para que la URL sea compatible con el SDK de Firebase
  const downloadToken = uuidv4();

  await bucket.upload(localPath, {
    destination,
    metadata: {
      contentType: 'video/mp4',
      metadata: {
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  // URL en formato firebasestorage.googleapis.com (compatible con CORS y la webapp)
  const encodedPath = encodeURIComponent(destination);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
}
