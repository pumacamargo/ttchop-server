export function planCarouselBackgroundBackfill(carousels) {
  const candidates = new Map();
  for (const carousel of carousels ?? []) {
    if (carousel?.projectId !== 'ttchop2' || !carousel.userId || !carousel.id || !Array.isArray(carousel.slides)) continue;
    const accountId = carousel.accountId ?? null;
    carousel.slides.forEach((slide, slideIndex) => {
      const bg = slide?.bg;
      if (bg?.status !== 'done' || !bg.taskId || !bg.url || !bg.storagePath) return;
      const key = JSON.stringify([carousel.projectId, carousel.userId, accountId, carousel.id, slideIndex, bg.taskId, bg.storagePath]);
      if (candidates.has(key)) return;
      candidates.set(key, {
        projectId: carousel.projectId, userId: carousel.userId, accountId,
        carouselId: carousel.id, slideIndex, taskId: bg.taskId,
        storagePath: bg.storagePath, url: bg.url,
        prompt: carousel.imageTaskPrompts?.[bg.taskId]?.prompt ?? null,
      });
    });
  }
  return [...candidates.values()].sort((a, b) =>
    a.projectId.localeCompare(b.projectId) || a.userId.localeCompare(b.userId) ||
    String(a.accountId ?? '').localeCompare(String(b.accountId ?? '')) ||
    a.carouselId.localeCompare(b.carouselId) || a.slideIndex - b.slideIndex ||
    a.taskId.localeCompare(b.taskId) || a.storagePath.localeCompare(b.storagePath));
}
