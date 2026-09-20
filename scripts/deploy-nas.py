#!/usr/bin/env python3
"""Isolated Motuo NAS deployment; SSH/Keychain credentials stay in memory.
Only /volume1/docker/motuo and motuo-* Docker resources may be mutated.
"""
import argparse, importlib.util, json, os, pathlib, shlex, subprocess, tarfile, tempfile, hashlib, datetime
ROOT=pathlib.Path(__file__).resolve().parents[1]
REMOTE='/volume1/docker/motuo'
DEFAULT_HELPER=pathlib.Path('/Users/qiuxuanmai/SynologyDrive/新医生/MedAgent OS/docs/feedback-20260912/nas-access.py')
PRIVATE=ROOT/'.private'

def access():
    p=pathlib.Path(os.environ.get('MOTUO_NAS_ACCESS_HELPER',str(DEFAULT_HELPER)))
    spec=importlib.util.spec_from_file_location('motuo_nas_access',p)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod

def remote(code,data=b'',timeout=90):
    return access().run('python3 -c '+shlex.quote(code),data,timeout)

def snapshot():
    code='''import subprocess,json
D='/usr/local/bin/docker'
rows=[]
for name in ['motuo-postgres','motuo-api','motuo-worker']:
 r=subprocess.run([D,'inspect',name],capture_output=True,text=True)
 if r.returncode:rows.append({'name':name,'exists':False});continue
 d=json.loads(r.stdout)[0];rows.append({'name':name,'exists':True,'image':d['Config']['Image'],'imageId':d['Image'],'status':d['State']['Status'],'health':d['State'].get('Health',{}).get('Status'),'ports':d['NetworkSettings']['Ports']})
print(json.dumps(rows))
'''
    print(remote(code,timeout=45).decode().strip())

def package(release):
    buf=tempfile.TemporaryFile()
    hashes={}
    with tarfile.open(fileobj=buf,mode='w:gz') as tar:
        for folder in ['server','worker','deploy']:
            for p in sorted((ROOT/folder).rglob('*')):
                rel=p.relative_to(ROOT)
                if any(part in {'node_modules','dist','.venv','__pycache__','.pytest_cache','data'} for part in rel.parts):continue
                if not p.is_file() or p.is_symlink() or p.name.startswith('.env') or p.suffix in {'.log','.pyc'}:continue
                hashes[str(rel)]=hashlib.sha256(p.read_bytes()).hexdigest();tar.add(p,arcname=str(rel),recursive=False)
    buf.seek(0);data=buf.read();buf.close()
    code='''import sys,tarfile,io,pathlib,json,os
root=pathlib.Path('/volume1/docker/motuo')
root.mkdir(mode=0o700,parents=True,exist_ok=True)
stage=root/'releases'/__RELEASE__
if stage.exists():raise RuntimeError('RELEASE_ALREADY_EXISTS')
stage.mkdir(parents=True,mode=0o700)
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as tar:
 for member in tar.getmembers():
  if member.issym() or member.islnk() or member.name.startswith('/') or '..' in pathlib.PurePosixPath(member.name).parts:raise RuntimeError('UNSAFE_MEMBER')
 tar.extractall(stage)
print(json.dumps({'staged':str(stage)}))
'''.replace('__RELEASE__',repr(release))
    print(remote(code,data,120).decode().strip())
    PRIVATE.mkdir(mode=0o700,exist_ok=True)
    (PRIVATE/'nas-release-state.json').write_text(json.dumps({'release':release,'hashes':hashes},indent=2)+'\n')
    os.chmod(PRIVATE/'nas-release-state.json',0o600)

def prepare(release):
    code='''import pathlib,subprocess,json,secrets,os
root=pathlib.Path('/volume1/docker/motuo');root.mkdir(mode=0o700,parents=True,exist_ok=True)
for name in ['data','postgres','backups']:(root/name).mkdir(mode=0o700,exist_ok=True)
os.chown(root/'data',1000,1000)
p=root/'.env'
if not p.exists():
 password=secrets.token_urlsafe(36)
 ai={}
 raw=subprocess.run(['/usr/local/bin/docker','inspect','medagent-backend'],capture_output=True,text=True)
 if raw.returncode==0:
  env=json.loads(raw.stdout)[0]['Config']['Env'];ev=dict(item.split('=',1) for item in env if '=' in item)
  ai={'AI_BASE_URL':ev.get('QWEN_BASE_URL',''),'AI_MODEL':ev.get('QWEN_MODEL',''),'AI_API_KEY':ev.get('QWEN_API_KEY','')}
 values={'POSTGRES_PASSWORD':password,'DATABASE_URL':'postgresql://motuo:'+password+'@postgres:5432/motuo','MOTUO_RELEASE':__RELEASE__,**ai}
 for v in values.values():
  if '\\n' in v or '\\r' in v or "'" in v:raise RuntimeError('UNSUPPORTED_ENV_VALUE')
 p.write_text(''.join(k+"='"+v+"'\\n" for k,v in values.items()));os.chmod(p,0o600)
else:
 lines=p.read_text().splitlines();lines=[l for l in lines if not l.startswith('MOTUO_RELEASE=')];lines.append('MOTUO_RELEASE='+__RELEASE__);p.write_text('\\n'.join(lines)+'\\n');os.chmod(p,0o600)
print(json.dumps({'envExists':True,'envMode':oct(p.stat().st_mode & 0o777),'dataUID':(root/'data').stat().st_uid,'release':__RELEASE__}))
'''.replace('__RELEASE__',repr(release))
    print(remote(code,timeout=60).decode().strip())

def compose(release,operation,services):
    if operation not in ['build','up']:raise ValueError(operation)
    allowed={'api','worker','postgres'}
    if any(s not in allowed for s in services):raise ValueError('Invalid service')
    command=['/usr/local/bin/docker','compose','--env-file',REMOTE+'/.env','-f',REMOTE+'/releases/'+release+'/deploy/compose.nas.yml']
    command+=['build',*services] if operation=='build' else ['up','-d','--no-build','--pull','never',*services]
    code='''import subprocess,json,pathlib,os,time
root=pathlib.Path('/volume1/docker/motuo');log=root/'deploy-__LOG_RELEASE__-__LOG_OPERATION__.log'
with log.open('ab') as f:
 p=subprocess.Popen(COMMAND,stdout=f,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,MOTUO_RELEASE=__TARGET_TAG__))
os.chmod(log,0o600)
print(json.dumps({'pid':p.pid,'log':str(log)}))
'''.replace('__LOG_RELEASE__',release).replace('__LOG_OPERATION__',operation).replace('COMMAND',repr(command)).replace('__TARGET_TAG__',repr(release))
    print(remote(code,timeout=30).decode().strip())

def health():
    code='''import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:3020/healthz',timeout=10) as response:
 print(json.dumps({'http':response.status,'body':json.loads(response.read())}))
'''
    print(remote(code,timeout=30).decode().strip())

def pairing():
    code='''import subprocess,json,pathlib,os
p=pathlib.Path('/volume1/docker/motuo/pairing.json')
command=['/usr/local/bin/docker','exec']
if p.exists():command+=['-e','OWNER_ID='+json.loads(p.read_text())['ownerId']]
command+=['motuo-api','node','dist/src/bootstrap.js']
r=subprocess.run(command,capture_output=True,text=True,check=True)
value=json.loads(r.stdout);p.write_text(json.dumps(value)+'\\n');os.chmod(p,0o600)
print(json.dumps({'ownerId':value['ownerId'],'remotePairingFile':str(p),'expiresInSeconds':value['expiresInSeconds']}))
'''
    print(remote(code,timeout=45).decode().strip())
    secret=remote("import pathlib;print(pathlib.Path('/volume1/docker/motuo/pairing.json').read_text(),end='')",timeout=30)
    PRIVATE.mkdir(mode=0o700,exist_ok=True);p=PRIVATE/'nas-pairing.json';p.write_bytes(secret);os.chmod(p,0o600)
    print(json.dumps({'localPairingFile':str(p)}))

def log(release,operation):
    # Build logs contain only source/dependency output, never environment or inspect output.
    code='''import pathlib,subprocess,json
p=pathlib.Path(PATH)
print(p.read_text(errors='replace')[-6000:] if p.exists() else 'NO_LOG')
'''.replace('PATH',repr(REMOTE+'/deploy-'+release+'-'+operation+'.log'))
    print(remote(code,timeout=30).decode().strip())

parser=argparse.ArgumentParser();parser.add_argument('action',choices=['package','prepare','build','up','snapshot','health','pair','log']);parser.add_argument('--release');parser.add_argument('--services',nargs='+',default=['api']);parser.add_argument('--operation',default='build',choices=['build','up']);args=parser.parse_args()
release=args.release
if not release and (PRIVATE/'nas-release-state.json').exists():release=json.loads((PRIVATE/'nas-release-state.json').read_text())['release']
if args.action in {'package','prepare','build','up','log'} and not release:parser.error('--release required')
if release and not all(c.isalnum() or c=='-' for c in release):parser.error('Invalid release')
if args.action=='package':package(release)
elif args.action=='prepare':prepare(release)
elif args.action in {'build','up'}:compose(release,args.action,args.services)
elif args.action=='snapshot':snapshot()
elif args.action=='health':health()
elif args.action=='pair':pairing()
elif args.action=='log':log(release,args.operation)
