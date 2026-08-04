#!/usr/bin/env python3
"""
Beat/onset detector for Speed Ramp pipeline.
Outputs hybrid trigger list: onset (intro) + drop (first sound after silence) + beats (post-drop).
Usage: python3 beat_detector.py <audio_path>
"""
import sys
import json
import librosa
import numpy as np


def detect_beats(audio_path):
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    # Tempo and beats
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='frames')
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    bpm = float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo)

    # Onset strength
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_frames_idx = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr,
        pre_max=3, post_max=3, pre_avg=5, post_avg=5, delta=0.1, wait=5
    )
    onset_times_all = librosa.frames_to_time(onset_frames_idx, sr=sr)
    onset_strengths = [float(onset_env[f]) for f in onset_frames_idx]

    # Detect silence → find main drop (first high-energy onset after longest silence before 15s)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)
    silence_threshold = rms.max() * 0.10

    in_silence = False
    sil_start = 0.0
    silence_end = None
    for t, silent in zip(rms_times, rms < silence_threshold):
        if silent and not in_silence:
            in_silence = True
            sil_start = float(t)
        elif not silent and in_silence:
            in_silence = False
            gap = float(t) - sil_start
            if gap > 0.3 and float(t) < 15.0:
                silence_end = float(t)

    drop_time = None
    if silence_end:
        candidates = [(float(t), s) for t, s in zip(onset_times_all, onset_strengths) if float(t) >= silence_end]
        if candidates:
            drop_time = round(candidates[0][0], 3)

    # Build hybrid trigger list
    # 1. Pre-drop: onsets with 1s min gap and strength > 3
    MIN_GAP = 1.0
    triggers = []
    last_t = -MIN_GAP
    for t, s in zip(onset_times_all, onset_strengths):
        t = float(t)
        if drop_time and t >= drop_time:
            break
        if s > 3 and (t - last_t) >= MIN_GAP:
            triggers.append({'time': round(t, 3), 'type': 'onset', 'strength': round(s, 2)})
            last_t = t

    # 2. Drop
    if drop_time:
        triggers.append({'time': drop_time, 'type': 'drop', 'strength': None})

    # 3. Post-drop: beats
    for bt in beat_times:
        bt = float(bt)
        if drop_time and bt > drop_time + 0.2:
            triggers.append({'time': round(bt, 3), 'type': 'beat', 'strength': None})

    # Add end marker
    triggers.append({'time': round(duration, 3), 'type': 'end', 'strength': None})

    print(json.dumps({
        'bpm': round(bpm, 2),
        'duration': round(duration, 3),
        'beat_interval': round(60.0 / bpm, 4),
        'drop_time': drop_time,
        'beats': [round(float(t), 3) for t in beat_times],
        'triggers': triggers,
        'trigger_count': len(triggers),
    }))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: beat_detector.py <audio_path>'}))
        sys.exit(1)
    detect_beats(sys.argv[1])
