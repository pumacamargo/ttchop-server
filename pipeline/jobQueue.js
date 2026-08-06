const COOLDOWN_MS = 5_000; // pausa entre jobs

const queue = [];
let isRunning = false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function drain() {
  if (isRunning || queue.length === 0) return;
  isRunning = true;
  const { fn, jobId } = queue.shift();
  // Notify remaining items of updated position
  queue.forEach((item, i) => {
    console.log(`[queue] ${item.jobId} now at position ${i + 1}`);
  });
  console.log(`[queue] Starting job ${jobId} (${queue.length} remaining in queue)`);
  try {
    await fn();
  } catch (err) {
    console.error(`[queue] Job ${jobId} threw:`, err.message);
  } finally {
    console.log(`[queue] Job ${jobId} done — cooling down ${COOLDOWN_MS}ms`);
    await sleep(COOLDOWN_MS);
    isRunning = false;
    drain();
  }
}

/**
 * Enqueue a job function. Returns immediately with queue position (0 = runs now).
 * @param {string} jobId  - for logging
 * @param {() => Promise} fn - async function that runs the job
 * @returns {number} position in queue (0 = starts immediately)
 */
export function enqueue(jobId, fn) {
  const position = isRunning ? queue.length + 1 : 0;
  queue.push({ jobId, fn });
  console.log(`[queue] Enqueued ${jobId} at position ${position} (queue length: ${queue.length})`);
  drain();
  return position;
}

export function queueLength() {
  return queue.length;
}

export function isQueueRunning() {
  return isRunning;
}
