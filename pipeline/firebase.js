import { getApps, initializeApp, cert, getApp as getAdminApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// Proyecto por defecto: el que usa la app original (ttchop). Cualquier request
// que no traiga `projectId`, o que traiga uno desconocido, cae aquí — así el
// comportamiento de siempre queda intacto sin importar qué se agregue después.
export const DEFAULT_PROJECT_ID = 'ttchop';

// Registro de proyectos soportados y sus variables de entorno. El proyecto
// por defecto usa las variables "de siempre" (sin sufijo); los adicionales
// llevan sufijo _<PROJECTID_EN_MAYUSCULAS>. Agregar un proyecto nuevo es
// agregar una entrada aquí + sus variables de entorno.
const PROJECT_ENV_KEYS = {
  ttchop: {
    serviceAccount: 'FIREBASE_SERVICE_ACCOUNT',
    serviceAccountPath: 'FIREBASE_SERVICE_ACCOUNT_PATH',
    storageBucket: 'FIREBASE_STORAGE_BUCKET',
  },
  ttchop2: {
    serviceAccount: 'FIREBASE_SERVICE_ACCOUNT_TTCHOP2',
    serviceAccountPath: 'FIREBASE_SERVICE_ACCOUNT_PATH_TTCHOP2',
    storageBucket: 'FIREBASE_STORAGE_BUCKET_TTCHOP2',
  },
};

// Cache de apps de firebase-admin ya inicializadas, por projectId.
const apps = new Map();

function buildCredential(keys) {
  const path = process.env[keys.serviceAccountPath];
  if (path) return cert(path);
  const json = process.env[keys.serviceAccount];
  if (json) return cert(JSON.parse(json));
  return null;
}

// Inicializa (una sola vez, de forma perezosa) la app de firebase-admin nombrada
// `projectId`. Devuelve null si no hay credenciales configuradas para ese proyecto.
function initProject(projectId) {
  const keys = PROJECT_ENV_KEYS[projectId];
  const credential = buildCredential(keys);
  if (!credential) return null;

  // Si el proceso ya registró una app con este nombre (p.ej. hot-reload), reusarla.
  const existing = getApps().find(a => a.name === projectId);
  const app = existing || initializeApp(
    {
      credential,
      storageBucket: process.env[keys.storageBucket],
    },
    projectId,
  );

  apps.set(projectId, app);
  return app;
}

// Nunca lanza por un projectId desconocido: preferimos escribir donde siempre
// que tumbar un render en producción por un valor inesperado.
function resolveProjectId(projectId) {
  if (!projectId) return DEFAULT_PROJECT_ID;
  if (!PROJECT_ENV_KEYS[projectId]) {
    console.warn(`[firebase] projectId desconocido "${projectId}" — usando "${DEFAULT_PROJECT_ID}"`);
    return DEFAULT_PROJECT_ID;
  }
  return projectId;
}

function getApp(projectId) {
  const id = resolveProjectId(projectId);
  if (apps.has(id)) return apps.get(id);

  const app = initProject(id);
  if (app) return app;

  // El proyecto es válido pero no tiene credenciales configuradas (p.ej.
  // ttchop2 sin FIREBASE_SERVICE_ACCOUNT_TTCHOP2 todavía). Caemos al default
  // en vez de romper el render.
  if (id !== DEFAULT_PROJECT_ID) {
    console.warn(`[firebase] Sin credenciales configuradas para "${id}" — usando "${DEFAULT_PROJECT_ID}"`);
    return getApp(DEFAULT_PROJECT_ID);
  }

  throw new Error('No Firebase credentials (FIREBASE_SERVICE_ACCOUNT o FIREBASE_SERVICE_ACCOUNT_PATH)');
}

export function getDb(projectId) {
  return getFirestore(getApp(projectId));
}

export function getBucket(projectId) {
  return getStorage(getApp(projectId)).bucket();
}

// Proyectos que sí tienen credenciales en el entorno (para que el scheduler
// sepa cuáles sondear). ttchop siempre debería estar si el servidor está
// configurado correctamente; ttchop2 solo aparece si se configuró.
export function getConfiguredProjects() {
  return Object.keys(PROJECT_ENV_KEYS).filter(id => {
    const keys = PROJECT_ENV_KEYS[id];
    return Boolean(process.env[keys.serviceAccountPath] || process.env[keys.serviceAccount]);
  });
}

// Mantenida por compatibilidad con código que solo necesita asegurar que el
// proyecto por defecto esté inicializado (comportamiento equivalente al de antes).
export function ensureFirebase() {
  getApp(DEFAULT_PROJECT_ID);
}

// Re-exportado por si algo necesita la app cruda de firebase-admin.
export { getAdminApp };
