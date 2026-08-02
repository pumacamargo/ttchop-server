import { getApps, initializeApp, cert } from 'firebase-admin/app';

let initialized = false;

export function ensureFirebase() {
  if (initialized || getApps().length > 0) return;

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credential = cert(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else {
    throw new Error('No Firebase credentials (FIREBASE_SERVICE_ACCOUNT o FIREBASE_SERVICE_ACCOUNT_PATH)');
  }

  initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  initialized = true;
}
