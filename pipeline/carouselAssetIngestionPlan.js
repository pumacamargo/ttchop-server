import { buildCarouselBackgroundAssetRecord } from './carouselBackgroundAssetRecord.js';

export function planCarouselAssetIngestion(carousel, taskId) {
  const slides = carousel?.slides;
  if (!Array.isArray(slides)) {
    throw new Error('Carousel asset ingestion requires slides');
  }

  const unique = new Map();
  for (const slide of slides) {
    if (slide?.bg?.status !== 'done' || slide.bg.taskId !== taskId) continue;
    const asset = buildCarouselBackgroundAssetRecord(carousel, slide);
    const key = JSON.stringify(asset);
    if (!unique.has(key)) unique.set(key, asset);
  }

  return [...unique.values()].sort((a, b) =>
    a.sourceSlideIndex - b.sourceSlideIndex || JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
}
