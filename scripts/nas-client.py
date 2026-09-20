#!/usr/bin/env python3
"""Create a separate device token for integration under the existing personal owner.
The user's unconsumed pairing code is not consumed. Secrets remain in mode-0600 files.
"""
import importlib.util,json,os,pathlib,shlex
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=pathlib.Path(os.environ.get('MOTUO_NAS_ACCESS_HELPER','/Users/qiuxuanmai/SynologyDrive/新医生/MedAgent OS/docs/feedback-20260912/nas-access.py'))
spec=importlib.util.spec_from_file_location('access',p);access=importlib.util.module_from_spec(spec);spec.loader.exec_module(access)
code=r'''
import pathlib,json,subprocess,urllib.request,os
root=pathlib.Path('/volume1/docker/motuo');owner=json.loads((root/'pairing.json').read_text())['ownerId']
client=root/'client.json'
if client.exists():
 value=json.loads(client.read_text())
 if value['ownerId']!=owner:raise RuntimeError('CLIENT_OWNER_MISMATCH')
else:
 paired=json.loads(subprocess.check_output(['/usr/local/bin/docker','exec','-e','OWNER_ID='+owner,'motuo-api','node','dist/src/bootstrap.js'],text=True))
 request=urllib.request.Request('http://127.0.0.1:3020/v1/pair',method='POST',data=json.dumps({'code':paired['code'],'deviceName':'Motuo deployment integration'}).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(request,timeout=15) as response:auth=json.loads(response.read())
 value={'baseURL':'http://100.74.46.95:3020','token':auth['token'],'ownerId':owner,'vehicleId':None}
 client.write_text(json.dumps(value)+'\n');os.chmod(client,0o600)
print(json.dumps(value))
'''
raw=access.run('python3 -c '+shlex.quote(code),timeout=45)
value=json.loads(raw);folder=ROOT/'.private';folder.mkdir(mode=0o700,exist_ok=True)
p=folder/'nas-client.json'
if p.exists():
 previous=json.loads(p.read_text())
 if previous.get('ownerId')!=value['ownerId']:raise RuntimeError('LOCAL_CLIENT_OWNER_MISMATCH')
 for key in ('vehicleId','baseURL'):
  if previous.get(key):value[key]=previous[key]
p.write_text(json.dumps(value)+'\n');os.chmod(p,0o600)
print(json.dumps({'ownerId':value['ownerId'],'clientFile':str(p),'mode':'0600','tokenPrinted':False}))
