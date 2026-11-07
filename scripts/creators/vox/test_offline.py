import copy,json,tempfile,unittest,subprocess,hashlib,wave
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
from clean_chroma import clean
from assemble_voice import assemble,read_pcm
from validate_timeline import validate

class OfflineCreatorTests(unittest.TestCase):
    def test_chroma_clean_full_resolution_component_and_holes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.png';output=root/'alpha.png'
            im=Image.new('RGB',(180,240),(8,225,9));d=ImageDraw.Draw(im)
            d.rounded_rectangle((60,20,119,219),radius=12,fill=(180,175,170))
            d.rectangle((80,70,87,77),fill=(8,225,9))
            d.rectangle((10,10,14,14),fill=(190,180,160));im.save(source)
            original=source.read_bytes();report=clean(source,output)
            self.assertEqual(source.read_bytes(),original)
            self.assertGreater(report['removed_island_pixels'],0)
            self.assertGreater(report['filled_accidental_hole_pixels'],0)
            self.assertEqual(report['interior_transparent_pixels'],0)
            self.assertEqual(report['source_size'],[180,240])
            self.assertLess(report['output_size'][0],80)
            pixels=np.array(Image.open(output));self.assertEqual(pixels[pixels.shape[0]//2,pixels.shape[1]//2,3],255)

    def test_magenta_key_keeps_white_subject(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'magenta.png'
            im=Image.new('RGB',(100,120),(255,0,255));ImageDraw.Draw(im).ellipse((25,15,75,105),fill=(245,242,238));im.save(source)
            report=clean(source,root/'cut.png')
            self.assertEqual(report['key'],'magenta');self.assertEqual(report['interior_transparent_pixels'],0)
            self.assertEqual(Image.open(root/'cut.png').getpixel((25,40))[3],255)

    def test_audio_is_offline_idempotent_and_preserves_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'input';source.mkdir()
            (source/'lines.json').write_text(json.dumps(['テスト一','テスト二']))
            for i,freq in [(1,440),(2,660)]:
                subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i',f'sine=frequency={freq}:duration=0.6','-ac','1','-ar','44100',str(source/f'line_{i:02}.mp3')],check=True)
            before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(source.glob('*.mp3'))]
            a=assemble(source,root/'a',1.5);b=assemble(source,root/'b',1.5)
            self.assertEqual(a['joined_paced_sha256'],b['joined_paced_sha256'])
            self.assertEqual(a['line_count'],2);self.assertEqual(a['clipped_samples'],0)
            self.assertEqual(a['lines'][0]['end_sample'],a['lines'][1]['start_sample'])
            self.assertEqual(a['final_samples'],sum(x['final_samples'] for x in a['lines']))
            self.assertEqual(len(read_pcm(root/'a/joined_paced.wav'))//2,a['final_samples'])
            self.assertEqual(before,[hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(source.glob('*.mp3'))])

    def test_missing_audio_fails_before_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'lines.json').write_text('["未完"]')
            with self.assertRaises(ValueError):assemble(root,root/'output',1.5)
            self.assertFalse((root/'output').exists())

    def test_timeline_uses_measured_clock_and_checks_gaps(self):
        c=dict(duration=2,frames=60,fps=30,scenes=[dict(start=0,end=1,voice_lines=[1],captions=[dict(at=0,text='一')]),dict(start=1,end=2,voice_lines=[2],captions=[dict(at=0,text='二')])])
        a=dict(final_samples=88200,sample_rate=44100,lines=[{},{}])
        self.assertTrue(validate(c,a,2,2)['passed'])
        for mutate in ['gap','frames','missing_line','caption']:
            bad=copy.deepcopy(c)
            if mutate=='gap':bad['scenes'][1]['start']=1.1
            elif mutate=='frames':bad['frames']=59
            elif mutate=='missing_line':bad['scenes'][1]['voice_lines']=[]
            else:bad['scenes'][0]['captions'][0]['at']=.1
            with self.assertRaises(ValueError):validate(bad,a,2,2)

if __name__=='__main__':unittest.main()
