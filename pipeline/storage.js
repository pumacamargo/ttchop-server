import { getStorage } from 'firebase-admin/storage';
import { ensureFirebase } from './firebase.js';

export async function uploadToStorage(localPath, remoteFilename) {
  ensureFirebase();
  const bucket = getStorage().bucket();
  const destination = `collage/${remoteFilename}`;

  const [file] = await bucket.upload(localPath, {
    destination,
    metadata: { contentType: 'video/mp4' },
    public: true,
  });

  // URL pública directa (sin expiración)
  return `https://storage.googleapis.com/${bucket.name}/${destination}`;
}
