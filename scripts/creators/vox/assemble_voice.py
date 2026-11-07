#!/usr/bin/env python3
"""Assemble EXISTING numbered TTS lines to measured PCM. No API/network calls.

Input: lines.json plus line_01.mp3 ... line_NN.mp3. Original MP3s never modified.
One explicit local atempo operation per complete line; no trim, gain, pitch or gaps.
The exact output-sample boundaries are for editorial line cuts, not phonemes.
"""
from __future__ import annotations
import argparse,array,hashlib,json,math,subprocess,wave
from pathlib import Path

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read_pcm(path,rate=44100):
    with wave.open(str(path),'rb') as audio:
        if (audio.getnchannels(),audio.getsampwidth(),audio.getframerate()) != (1,2,rate):
            raise ValueError('Expected mono 16-bit PCM at '+str(rate))
        return audio.readframes(audio.getnframes())

def write_pcm(path,data,rate=44100):
    with wave.open(str(path),'wb') as audio:
        audio.setparams((1,2,rate,0,'NONE','not compressed'))
        audio.writeframes(data)

def assemble(source:Path,destination:Path,factor:float,fps:int=30):
    source=source.resolve();destination=destination.resolve()
    if not math.isfinite(factor) or not .5<=factor<=2:
        raise ValueError('factor must be explicitly within FFmpeg single-atempo range .5..2')
    if not 1<=fps<=240:
        raise ValueError('fps must be 1..240')
    lines=json.loads((source/'lines.json').read_text())
    if not isinstance(lines,list) or not lines or any(not isinstance(x,str) or not x.strip() for x in lines):
        raise ValueError('lines.json must be a nonempty list of nonblank strings')
    paths=[source/f'line_{i:02d}.mp3' for i in range(1,len(lines)+1)]
    for path in paths:
        if not path.is_file() or path.stat().st_size<100:
            raise ValueError('Missing or incomplete input '+str(path))
    # Fail before touching output if input is incomplete. No automatic TTS repair/retry.
    destination.mkdir(parents=True,exist_ok=True)
    raw_parts=[];final_parts=[];records=[];cursor=0
    for i,(text,mp3) in enumerate(zip(lines,paths),1):
        raw=destination/f'line_{i:02d}_raw.wav';final=destination/f'line_{i:02d}_paced.wav'
        for out in (raw,final):
            if out.resolve() in [p.resolve() for p in paths]:
                raise ValueError('Output cannot overwrite source MP3')
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(mp3),'-ac','1','-ar','44100','-c:a','pcm_s16le',str(raw)],check=True)
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(raw),'-af',f'atempo={factor:g}','-c:a','pcm_s16le',str(final)],check=True)
        a=read_pcm(raw);b=read_pcm(final);n=len(b)//2
        if not n:
            raise ValueError('Decoded line has no samples '+str(i))
        records.append(dict(line=i,text=text,characters=len(text),source_mp3_sha256=sha(mp3),raw_samples=len(a)//2,raw_seconds=len(a)/88200,final_samples=n,final_seconds=n/44100,start_sample=cursor,end_sample=cursor+n,start=cursor/44100,end=(cursor+n)/44100,characters_per_second=len(text)/(n/44100)))
        raw_parts.append(a);final_parts.append(b);cursor+=n
    raw_join=destination/'joined_raw.wav';final_join=destination/'joined_paced.wav'
    write_pcm(raw_join,b''.join(raw_parts));write_pcm(final_join,b''.join(final_parts))
    values=array.array('h',b''.join(final_parts))
    report=dict(schema_version=1,operation='offline-existing-audio-only',factor=factor,fps=fps,sample_rate=44100,line_count=len(lines),characters=sum(map(len,lines)),raw_seconds=sum(len(x) for x in raw_parts)/88200,final_samples=cursor,final_seconds=cursor/44100,video_frames=math.ceil(cursor/44100*fps),video_seconds=math.ceil(cursor/44100*fps)/fps,pcm_peak=max(abs(x) for x in values)/32768,clipped_samples=sum(abs(x)>=32767 for x in values),joined_raw_sha256=sha(raw_join),joined_paced_sha256=sha(final_join),alignment_policy='Exact PCM line boundaries only; no character/phoneme forced-alignment claim.',lines=records)
    (destination/'alignment.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return report

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--factor',type=float,required=True);parser.add_argument('--fps',type=int,default=30)
    args=parser.parse_args();result=assemble(args.input,args.output,args.factor,args.fps)
    print(json.dumps({k:v for k,v in result.items() if k!='lines'},indent=2))

if __name__=='__main__':
    main()
