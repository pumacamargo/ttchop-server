import { getBucket } from './firebase.js';
import { v4 as uuidv4 } from 'uuid';

export async function uploadToStorage(localPath, remoteFilename, projectId) {
  return uploadFileToStorage(localPath, `collage/${remoteFilename}`, 'video/mp4', projectId);
}

// Igual que uploadToStorage pero con carpeta/contentType configurables — usado para
// audio del personaje (character/), donde forzar video/mp4 y collage/ no aplica.
export async function uploadFileToStorage(localPath, destination, contentType, projectId) {
  const bucket = getBucket(projectId);
  const downloadToken = uuidv4();

  await bucket.upload(localPath, {
    destination,
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });

  const encodedPath = encodeURIComponent(destination);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
}
