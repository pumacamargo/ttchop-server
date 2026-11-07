#!/usr/bin/python3
"""Full-resolution single-subject chroma matte. No API or synthetic grain.
Requires existing Pillow and NumPy. Components/holes operate before any crop.
Only despills dominant key channel at edge, never subtracts RGB vectors.
"""
from pathlib import Path
from collections import deque
import argparse,json,hashlib
import numpy as np
from PIL import Image,ImageDraw,ImageFilter

def clean(source,destination):
 im=Image.open(source).convert('RGB');rgb=np.array(im);a=rgb.astype('int16');h,w=a.shape[:2]
 border=np.concatenate([a[0],a[-1],a[:,0],a[:,-1]])
 med=np.median(border,axis=0);green=med[1]>max(med[0],med[2]);magenta=min(med[0],med[2])>med[1]
 if green:key=(a[:,:,1]-a[:,:,0]>22)&(a[:,:,1]-a[:,:,2]>22)
 elif magenta:key=(np.minimum(a[:,:,0],a[:,:,2])-a[:,:,1]>32)
 else:raise ValueError('Source must have green or magenta dominant border')
 # Remove isolated dust; retain the single largest full-resolution component.
 m=np.array(Image.fromarray((~key).astype('uint8')*255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)))>0
 seen=np.zeros((h,w),bool);best=[];counts=[]
 for y,x in zip(*np.where(m)):
  if seen[y,x]:continue
  q=deque([(y,x)]);seen[y,x]=True;component=[]
  while q:
   yy,xx=q.popleft();component.append((yy,xx))
   for y2,x2 in [(yy-1,xx),(yy+1,xx),(yy,xx-1),(yy,xx+1)]:
    if 0<=y2<h and 0<=x2<w and m[y2,x2] and not seen[y2,x2]:seen[y2,x2]=True;q.append((y2,x2))
  counts.append(len(component))
  if len(component)>len(best):best=component
 mask=Image.new('L',(w,h));arr=np.zeros((h,w),np.uint8)
 for y,x in best:arr[y,x]=255
 mask=Image.fromarray(arr)
 # Exterior flood fill makes internal accidental chroma holes completely opaque.
 exterior=mask.copy();ImageDraw.floodfill(exterior,(0,0),128,thresh=0)
 filled=np.where(np.array(exterior)==128,0,255).astype('uint8')
 holes=int(((filled>0)&(arr==0)).sum());hard=Image.fromarray(filled)
 alpha=hard.filter(ImageFilter.GaussianBlur(.45));aa=np.array(alpha)
 inner=np.array(hard.filter(ImageFilter.MinFilter(5)))>0
 edge=(aa>0)&~inner
 # Nearest valid interior pixel propagation for edge RGB only (bounded 3px fringe).
 assigned=inner.copy();out=rgb.copy()
 for _ in range(5):
  for dy,dx in [(-1,0),(1,0),(0,-1),(0,1)]:
   adj=np.roll(assigned,(dy,dx),(0,1));colors=np.roll(out,(dy,dx),(0,1));take=edge&~assigned&adj
   out[take]=colors[take];assigned[take]=True
 if green:out[:,:,1][edge]=np.minimum(out[:,:,1][edge],np.maximum(out[:,:,0][edge],out[:,:,2][edge])+6)
 else:
  for c in (0,2):out[:,:,c][edge]=np.minimum(out[:,:,c][edge],out[:,:,1][edge]+8)
 result=Image.fromarray(out).convert('RGBA');result.putalpha(alpha);bounds=alpha.getbbox();result=result.crop(bounds)
 destination.parent.mkdir(parents=True,exist_ok=True);result.save(destination)
 report=dict(source=str(source),source_size=[w,h],source_sha256=hashlib.sha256(Path(source).read_bytes()).hexdigest(),background_median=med.tolist(),key='green' if green else 'magenta',components=len(counts),retained_component_pixels=len(best),removed_island_pixels=sum(counts)-len(best),filled_accidental_hole_pixels=holes,crop=list(bounds),output_size=list(result.size),interior_transparent_pixels=int(((np.array(hard)>0)&(aa<250)&inner).sum()),output_sha256=hashlib.sha256(destination.read_bytes()).hexdigest())
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('destination',type=Path);p.add_argument('--report',type=Path);a=p.parse_args();r=clean(a.source,a.destination)
 if a.report:a.report.write_text(json.dumps(r,indent=2)+'\n')
 print(json.dumps(r,indent=2))
