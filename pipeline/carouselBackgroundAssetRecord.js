export function buildCarouselBackgroundAssetRecord(carousel, slide) {
  if (!carousel || carousel.projectId !== 'ttchop2') {
    throw new Error('Carousel background assets require project ttchop2');
  }
  if (typeof carousel.userId !== 'string' || !carousel.userId.trim()) {
    throw new Error('Carousel background assets require a userId');
  }

  const background = slide?.bg;
  const taskId = background?.taskId;
  if (background?.status !== 'done' || typeof taskId !== 'string' || !taskId.trim() ||
      typeof background.url !== 'string' || !background.url.trim() ||
      typeof background.storagePath !== 'string' || !background.storagePath.trim()) {
    throw new Error('Completed carousel background must include taskId, url, and storagePath');
  }

  const attribution = carousel.imageTaskPrompts?.[taskId];
  if (!Array.isArray(attribution?.imagePrompts) ||
      !attribution.imagePrompts.some(item => item?.index === slide.index)) {
    throw new Error(`Missing image prompt attribution for slide ${slide.index}`);
  }

  return {
    projectId: carousel.projectId,
    userId: carousel.userId,
    accountId: carousel.accountId || null,
    sourceCarouselId: carousel.id,
    sourceSlideIndex: slide.index,
    sourceTaskId: taskId,
    url: background.url,
    storagePath: background.storagePath,
    imageModel: carousel.imageModel,
    prompt: attribution.prompt,
  };
}
