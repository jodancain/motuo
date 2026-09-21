#!/usr/bin/env python3
"""Bundle the reviewed local HUD as a rendering surface; native code owns data/actions."""
from pathlib import Path
import hashlib, json, shutil, re
ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'prototypes/motuo-v2'
DST=ROOT/'ios/Motuo/Resources/Cockpit'
def main():
    model=SRC/'assets/models/suzuki-gsx-r1000/model.glb'
    manifest=json.loads(model.with_name('manifest.json').read_text())
    if hashlib.sha256(model.read_bytes()).hexdigest()!=manifest['sha256']: raise SystemExit('Selected model checksum mismatch')
    DST.mkdir(parents=True,exist_ok=True)
    for path in SRC.iterdir():
        if path.suffix in ['.js','.css'] and path.is_file(): shutil.copy2(path,DST/path.name)
    shutil.copytree(SRC/'vendor',DST/'vendor',dirs_exist_ok=True)
    target=DST/'assets/models/suzuki-gsx-r1000/model.glb';target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(model,target)
    html=(SRC/'index.html').read_text()
    def replace(old,new):
        nonlocal html
        if html.count(old)!=1: raise RuntimeError('Native bridge patch boundary changed: '+old[:70])
        html=html.replace(old,new)
    replace("const $=id=>", "const nativeHost=!!window.webkit?.messageHandlers?.motuo;\n const $=id=>")
    replace("if(state.phase==='riding'){state.seconds+=dt;", "if(!nativeHost&&state.phase==='riding'){state.seconds+=dt;")
    replace('function sampleAudio(){', 'function sampleAudio(){if(nativeHost){nativeAudio();return;}')
    replace("function stopInput(reason='off'){", "function stopInput(reason='off'){if(nativeHost)nativeSend('stopMicrophone');")
    replace("$('destination-label').textContent=state.destination;", "$('destination-label').textContent=state.destination;if(nativeHost)nativeLabels();")
    replace('updateMusic();renderInput();resizeFX();render();soundIntro();requestAnimationFrame(frame);',
            (ROOT/'ios/Motuo/Cockpit/native-runtime.js').read_text()+'\n updateMusic();renderInput();resizeFX();render();soundIntro();if(nativeHost)nativeSend("ready");requestAnimationFrame(frame);')
    html=html.replace('</head>','<link rel="stylesheet" href="native-runtime.css"></head>')
    (DST/'index.html').write_text(html)
    shutil.copy2(ROOT/'ios/Motuo/Cockpit/native-runtime.css',DST/'native-runtime.css')
    print(f'Native cockpit: {sum(1 for p in DST.rglob("*") if p.is_file())} allowlisted resources; selected model SHA verified')
if __name__=='__main__':main()
