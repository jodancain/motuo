#!/usr/bin/env python3
"""One synthetic provider request from the actual Motuo image, without printing credentials."""
import importlib.util,pathlib,shlex,json,os
ROOT=pathlib.Path(__file__).resolve().parents[1]
_helper=os.environ.get('MOTUO_NAS_ACCESS_HELPER')
if not _helper:raise SystemExit('Set MOTUO_NAS_ACCESS_HELPER to your private SSH/Keychain access helper module path.')
p=pathlib.Path(_helper)
s=importlib.util.spec_from_file_location('access',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
code=r'''
import pathlib,json,subprocess
values={}
for line in pathlib.Path('/volume1/docker/motuo/.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);values[k]=v.strip().strip("'")
config={'baseURL':values.get('AI_BASE_URL',''),'model':values.get('AI_MODEL',''),'key':values.get('AI_API_KEY','')}
script="""let raw='';for await(const c of process.stdin)raw+=c;const c=JSON.parse(raw);const started=Date.now();let result={configured:Boolean(c.baseURL&&c.model&&c.key),model:c.model};try{if(!result.configured)throw new Error('UNCONFIGURED');const r=await fetch(c.baseURL.replace(/\\/$/,'')+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+c.key,'content-type':'application/json'},body:JSON.stringify({model:c.model,messages:[{role:'user',content:'This is a synthetic motorcycle app connectivity test. Reply with exactly MOTUO_CANARY_OK and nothing else.'}],max_tokens:40,temperature:0}),signal:AbortSignal.timeout(30000)});const body=await r.json();const text=body.choices?.[0]?.message?.content;result={...result,http:r.status,passed:r.ok&&typeof text==='string'&&text.trim()==='MOTUO_CANARY_OK'};}catch(e){result={...result,passed:false,error:e.message==='UNCONFIGURED'?'unconfigured':'provider_or_transport_error'};}console.log(JSON.stringify({...result,elapsedMS:Date.now()-started}));"""
p=subprocess.run(['/usr/local/bin/docker','run','--rm','-i','--network','motuo-net','motuo-api:'+values['MOTUO_RELEASE'],'node','--input-type=module','-e',script],input=json.dumps(config).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
if p.returncode:raise RuntimeError('CANARY_EXEC_FAILED')
print(p.stdout.decode().strip())
'''
result=json.loads(m.run('python3 -c '+shlex.quote(code),timeout=80));(ROOT/'docs/nas-ai-canary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
