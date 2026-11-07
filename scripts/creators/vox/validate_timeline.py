#!/usr/bin/env python3
"""Validate a local editorial timeline against measured audio, not a legacy clock."""
import argparse,json,math
from pathlib import Path

def validate(config,alignment,expected_scenes=None,expected_captions=None):
    scenes=config['scenes'];duration=config['duration'];fps=config['fps'];frames=config['frames']
    if not scenes or not math.isfinite(duration) or duration<=0 or fps<=0:
        raise ValueError('Invalid empty/nonpositive timeline')
    if frames!=math.ceil(alignment['final_samples']/alignment['sample_rate']*fps):
        raise ValueError('Frame count does not cover measured PCM')
    if not math.isclose(duration,frames/fps,abs_tol=1e-9):
        raise ValueError('Timeline duration must equal frames/fps')
    if expected_scenes is not None and len(scenes)!=expected_scenes:
        raise ValueError('Wrong scene count')
    previous=0;captions=0
    for i,scene in enumerate(scenes):
        if not math.isclose(scene['start'],previous,abs_tol=1e-8) or scene['end']<=scene['start']:
            raise ValueError('Scene gap, overlap or nonpositive length at '+str(i))
        cues=scene['captions']
        if not cues or cues[0]['at']!=0:
            raise ValueError('Every scene needs a zero-time caption')
        last=-1
        for cue in cues:
            if not isinstance(cue['text'],str) or not cue['text'].strip():
                raise ValueError('Blank caption')
            if not math.isfinite(cue['at']) or not last<cue['at']<scene['end']-scene['start']:
                raise ValueError('Caption outside its scene or unordered')
            last=cue['at'];captions+=1
        previous=scene['end']
    if not math.isclose(previous,duration,abs_tol=1e-8):
        raise ValueError('Timeline does not end on declared final frame')
    if expected_captions is not None and captions!=expected_captions:
        raise ValueError('Wrong caption-state count')
    covered=set()
    for scene in scenes:
        covered.update(scene.get('voice_lines',[]))
    if covered and covered!=set(range(1,len(alignment['lines'])+1)):
        raise ValueError('Voice-line coverage omits or invents approved lines')
    return dict(passed=True,scene_count=len(scenes),caption_states=captions,frames=frames,fps=fps,seconds=duration,voice_lines=sorted(covered),timing_policy='Measured PCM frame coverage. Caption keyphrase timings are editorial, not phoneme alignment.')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('config',type=Path);p.add_argument('alignment',type=Path);p.add_argument('--scenes',type=int);p.add_argument('--captions',type=int);p.add_argument('--output',type=Path);a=p.parse_args()
    r=validate(json.loads(a.config.read_text()),json.loads(a.alignment.read_text()),a.scenes,a.captions)
    if a.output:a.output.write_text(json.dumps(r,indent=2)+'\n')
    print(json.dumps(r,indent=2))

if __name__=='__main__':main()
