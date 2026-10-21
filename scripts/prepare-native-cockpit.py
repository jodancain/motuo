#!/usr/bin/env python3
"""Bundle a reviewed local cockpit as the native rendering surface; native code owns data/actions.

Default is the v3 comic-MV cockpit (prototypes/motuo-v3). The v2 YU7/game cockpit stays buildable as a
fallback: `python3 scripts/prepare-native-cockpit.py --variant v2` (or MOTUO_COCKPIT=v2) before building.
Everything is local (fonts, vendor three, GLB); the script refuses remote URLs in the entry HTML/CSS.
The GLB is a local-only asset (gitignored); its distribution licence is still unverified (docs/STATUS.md).
"""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil
ROOT=Path(__file__).resolve().parents[1]
DST=ROOT/'ios/Motuo/Resources/Cockpit'
MODEL='assets/models/suzuki-gsx-r1000/model.glb'
# Must match CockpitAssetHandler's extension allowlist; anything else could not be served anyway.
SERVED={'.html','.js','.css','.glb','.png','.jpg','.svg','.txt','.woff2'}

def verified_model(*candidates):
    for model in candidates:
        if model.exists():
            manifest=json.loads(model.with_name('manifest.json').read_text())
            digest=hashlib.sha256(model.read_bytes()).hexdigest()
            if digest!=manifest['sha256']: raise SystemExit(f'Selected model checksum mismatch: {model}')
            return model,digest
    raise SystemExit('Model GLB missing; run scripts/prepare-suzuki-model.py first (local asset, not in Git)')

def copy_tree(src,dst):
    for path in sorted(src.rglob('*')):
        rel=path.relative_to(src)
        if path.is_dir() or any(p in {'tests','node_modules'} for p in rel.parts): continue
        if path.suffix not in SERVED and not path.name.startswith('LICENSE'): continue
        target=dst/rel; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(path,target)

def bundle_v3():
    src=ROOT/'prototypes/motuo-v3'
    model,digest=verified_model(src/MODEL,ROOT/'prototypes/motuo-v2'/MODEL)
    for name in ['app.js','native-adapter.js','styles.css']: shutil.copy2(src/name,DST/name)
    for folder in ['core','render','audio','data','shared','vendor','assets/fonts']: copy_tree(src/folder,DST/folder)
    target=DST/MODEL; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(model,target)
    html=(src/'index.html').read_text()
    if html.count('</head>')!=1: raise RuntimeError('Native bridge patch boundary changed: </head>')
    # Native-only layout (single navigation, scene mini-controls, safe areas). The bridge itself is native-adapter.js.
    html=html.replace('</head>','<link rel="stylesheet" href="native-runtime.css">\n</head>')
    (DST/'index.html').write_text(html)
    shutil.copy2(ROOT/'ios/Motuo/Cockpit/v3/native-runtime.css',DST/'native-runtime.css')
    return digest

def bundle_v2():
    src=ROOT/'prototypes/motuo-v2'
    model,digest=verified_model(src/MODEL)
    for path in src.iterdir():
        if path.suffix in ['.js','.css'] and path.is_file(): shutil.copy2(path,DST/path.name)
    shutil.copytree(src/'vendor',DST/'vendor',dirs_exist_ok=True)
    # Bundled OFL display fonts (woff2 + licenses); the WebView is offline.
    shutil.copytree(src/'assets/fonts',DST/'assets/fonts',dirs_exist_ok=True)
    target=DST/MODEL;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(model,target)
    html=(src/'index.html').read_text()
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
    return digest

def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--variant',choices=['v3','v2'],default=os.environ.get('MOTUO_COCKPIT','v3'))
    args=parser.parse_args()
    # Generated, gitignored output: rebuild from scratch so a v2 file can never linger in a v3 bundle.
    if DST.exists(): shutil.rmtree(DST)
    DST.mkdir(parents=True)
    digest=bundle_v3() if args.variant=='v3' else bundle_v2()
    for entry in ['index.html','styles.css','native-runtime.css']:
        path=DST/entry
        if path.exists() and re.search(r'https?://(?!127\.0\.0\.1)',re.sub(r'<!--[\s\S]*?-->','',path.read_text())): raise SystemExit(f'Remote URL in bundled {entry}; the cockpit must stay offline')
    files=sorted(str(p.relative_to(DST)) for p in DST.rglob('*') if p.is_file())
    unserved=[f for f in files if Path(f).suffix not in SERVED and not Path(f).name.startswith('LICENSE')]
    if unserved: raise SystemExit(f'Files the asset handler cannot serve: {unserved[:5]}')
    # Read by NativeCockpitView to pick the matching bridge behaviour (navigation, countdown, recap).
    (DST/'cockpit-manifest.json').write_text(json.dumps({'variant':args.variant,'modelSha256':digest,'files':len(files)},indent=2))
    print(f'Native cockpit {args.variant}: {len(files)} allowlisted resources; selected model SHA verified')
if __name__=='__main__':main()
