// Projection of the FINAL builder recipe. Never serialize the recipe itself: it
// contains signed URLs, local paths and potentially untrusted LLM fields.
export function createCollageEditManifest(clips, sessions, audioDurationSeconds, originalClipCount = clips.length) {
  const sources = new Map();
  for (const session of sessions) {
    for (const video of session.videos || []) {
      if (!video.id) continue;
      if (sources.has(video.id)) throw new Error(`Ambiguous source clip ID: ${video.id}`);
      // IDs are provenance only; never allow URL/path-shaped identifiers to
      // smuggle signed credentials or local paths into the manifest.
      if (![video.id, session.id].every(id => typeof id === 'string' && id && !/[\/?#=]/.test(id) && !/^https?:/i.test(id))) {
        throw new Error('Unsafe collage source identifier');
      }
      sources.set(video.id, { sessionId: session.id, sourceClipId: video.id });
    }
  }
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) {
    throw new Error("Invalid audio duration for collage manifest");
  }

  const segments = [];
  let cursor = 0;
  for (const [recipeIndex, clip] of clips.entries()) {
    // collage_builder.py skips non-positive trims before concatenation.
    const start = Number(clip.trimStart ?? 0);
    const end = Number(clip.trimEnd ?? 0);
    const speed = Number(clip.speed ?? 1);
    if (![start, end, speed].every(Number.isFinite) || speed <= 0 || start < 0) {
      throw new Error(`Invalid trim/speed at recipe index ${recipeIndex}`);
    }
    if (end <= start) continue;
    const id = clip.clipId;
    // Prefer an exact match for genuine source IDs ending in _extN. Fillers
    // inherit the provenance of the selected clip, even with nested suffixes.
    let source = recipeIndex < originalClipCount ? sources.get(id) : null;
    let baseId = id;
    while (!source && typeof baseId === "string" && /_ext\d+$/.test(baseId)) {
      baseId = baseId.replace(/_ext\d+$/, "");
      source = sources.get(baseId);
    }
    if (!source) throw new Error(`Unknown source clip at recipe index ${recipeIndex}`);

    // Builder: -ss start -t (end-start), setpts=round(1/speed, 6)*PTS,
    // concat in recipe order, then mux audio with -shortest. The ffmpeg output
    // is frame/codec dependent; these are planned times, NOT measured MP4 cuts.
    const ptsFactor = speed === 1 ? 1 : Math.round(1 / speed * 1e6) / 1e6;
    const videoDuration = (end - start) * ptsFactor;
    const timelineStart = cursor;
    cursor += videoDuration;
    const timelineEnd = Math.max(timelineStart, Math.min(cursor, audioDurationSeconds));
    segments.push({
      index: segments.length,
      recipeIndex,
      sessionId: source.sessionId,
      sourceClipId: source.sourceClipId,
      role: clip.role || "",
      repeated: recipeIndex >= originalClipCount,
      sourceStartSeconds: start,
      sourceEndSeconds: timelineEnd === cursor ? end : start + (timelineEnd - timelineStart) / ptsFactor,
      speed,
      timelineStartSeconds: timelineStart,
      timelineEndSeconds: timelineEnd,
      outputDurationSeconds: timelineEnd - timelineStart,
    });
  }
  if (!segments.length) throw new Error("No usable collage segments");
  return {
    version: 1,
    timingBasis: "planned; builder setpts factor rounded to 6 decimals, concat order, audio -shortest; MP4 frame/codec durations may differ",
    audioDurationSeconds,
    plannedVideoDurationSeconds: cursor,
    plannedTimelineDurationSeconds: Math.min(cursor, audioDurationSeconds),
    segments,
  };
}

// ffprobe measures each transcoded clip before concat; the final ffprobe
// duration bounds the visible intervals after the builder's -shortest mux.
// These are media-duration measurements, not a frame-accurate mux edit list.
export function attachCollageMeasurements(manifest, trimmedSegments, finalDuration) {
  if (!Array.isArray(trimmedSegments) || !Number.isFinite(finalDuration) || finalDuration < 0) {
    throw new Error('Invalid collage builder measurements');
  }
  const measuredSegments = [];
  let cursor = 0;
  for (const { recipeIndex, measuredDurationSeconds } of trimmedSegments) {
    if (!Number.isFinite(measuredDurationSeconds) || measuredDurationSeconds < 0) {
      throw new Error('Invalid trimmed clip duration');
    }
    const start = cursor;
    cursor += measuredDurationSeconds;
    const end = Math.min(cursor, finalDuration);
    if (end > start) {
      const source = manifest.segments.find(s => s.recipeIndex === recipeIndex);
      if (!source) throw new Error(`Unknown measured recipe index ${recipeIndex}`);
      measuredSegments.push({
        recipeIndex, sessionId: source.sessionId, sourceClipId: source.sourceClipId,
        timelineStartSeconds: start, timelineEndSeconds: end,
        outputDurationSeconds: end - start,
      });
    }
  }
  return { ...manifest, actualMp4DurationSeconds: finalDuration, measuredVideoSegments: measuredSegments };
}
