#!/usr/bin/env python3
"""Run a synthetic owner-scoped HTTP/DB smoke on Motuo only; erase its account afterward."""
import pathlib,importlib.util,shlex,json,os
ROOT=pathlib.Path(__file__).resolve().parents[1]
helper=pathlib.Path(os.environ.get('MOTUO_NAS_ACCESS_HELPER','/Users/qiuxuanmai/SynologyDrive/新医生/MedAgent OS/docs/feedback-20260912/nas-access.py'))
spec=importlib.util.spec_from_file_location('motuo_nas_access',helper);access=importlib.util.module_from_spec(spec);spec.loader.exec_module(access)
code=r'''
import subprocess,json,uuid,hashlib,time,urllib.request,urllib.error,pathlib
base='http://127.0.0.1:3020'; token=None;results=[]
def check(name,ok):
 results.append({'name':name,'passed':bool(ok)})
 if not ok:raise RuntimeError('SMOKE_ASSERTION_'+name)
def request(method,route,body=None,raw=False,digest=None):
 headers={}
 if token:headers['Authorization']='Bearer '+token
 if raw:headers['Content-Type']='application/octet-stream';headers['X-Content-SHA256']=digest or hashlib.sha256(body).hexdigest();data=body
 else:
  data=None if body is None else json.dumps(body).encode()
  if body is not None:headers['Content-Type']='application/json'
 try:
  with urllib.request.urlopen(urllib.request.Request(base+route,data=data,method=method,headers=headers),timeout=40) as r:
   data=r.read();return r.status,json.loads(data) if 'application/json' in r.headers.get('Content-Type','') else data
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
try:
 check('health',request('GET','/healthz')[0]==200)
 check('unauthenticated_401',request('GET','/v1/vehicles')[0]==401)
 paired=json.loads(subprocess.check_output(['/usr/local/bin/docker','exec','motuo-api','node','dist/src/bootstrap.js'],text=True))
 status,auth=request('POST','/v1/pair',{'code':paired['code'],'deviceName':'NAS synthetic smoke'});check('pair',status==200);token=auth['token']
 check('pair_code_single_use',request('POST','/v1/pair',{'code':paired['code'],'deviceName':'repeat'})[0]==401)
 vehicle=str(uuid.uuid4());ride=str(uuid.uuid4());event=str(uuid.uuid4());maintenance=str(uuid.uuid4())
 v={'id':vehicle,'name':'FICTIONAL NAS SMOKE','make':'Suzuki','model':'GSX250R','year':None,'abs':None,'displacementCC':248,'plate':'','tyres':'','modifications':'','odometerKM':0}
 check('vehicle_create',request('PUT','/v1/vehicles/'+vehicle,v)[0]==200)
 r={'id':ride,'vehicleId':vehicle,'startedAt':'2026-09-14T04:00:00Z','endedAt':None,'status':'recording','source':'simulated','distanceM':0,'durationS':10,'maxSpeedMPS':0,'meanSpeedMPS':0,'dataVersion':1,'events':[{'id':event,'type':'synthetic','window':{'start':0,'end':1}}],'summary':{}}
 check('ride_create',request('PUT','/v1/rides/'+ride,r)[0]==200)
 sample=json.dumps({'timestamp':'2026-09-14T04:00:01Z','monotonicS':1,'source':'simulated','quality':'unavailable'}).encode()+bytes([10])
 route='/v1/rides/'+ride+'/chunks/0'
 check('checksum_422',request('PUT',route,sample,True,'0'*64)[0]==422)
 check('raw_chunk',request('PUT',route,sample,True)[0]==200)
 check('chunk_idempotence',request('PUT',route,sample,True)[1].get('duplicate') is True)
 finish={'dataVersion':1,'expectedChunks':2,'summary':{'validSpeedSamples':0},'endedAt':'2026-09-14T04:00:10Z'}
 check('missing_chunk_409',request('POST','/v1/rides/'+ride+'/finish',finish)[0]==409)
 finish['expectedChunks']=1;check('finish',request('POST','/v1/rides/'+ride+'/finish',finish)[0]==200)
 report={}
 for _ in range(40):
  status,report=request('GET','/v1/rides/'+ride+'/report')
  if report.get('status')=='ready':break
  time.sleep(1)
 check('report_ready',report.get('status')=='ready' and report.get('dataVersion')==1)
 check('simulated_report_label','模拟' in report.get('text',''))
 check('missing_speed_not_zero','最高速度 0' not in report.get('text',''))
 check('feedback',request('POST','/v1/rides/'+ride+'/events/'+event+'/feedback',{'label':'rejected','note':'Synthetic smoke only'})[0]==200)
 check('maintenance',request('POST','/v1/maintenance',{'id':maintenance,'vehicleId':vehicle,'performedAt':'2026-09-14T04:00:10Z','odometerKM':0,'category':'synthetic','note':'No real maintenance performed'})[0]==200)
 check('no_evidence',request('POST','/v1/manuals/ask',{'vehicleId':vehicle,'question':'虚构不存在的部件'})[1].get('source')=='no_evidence')
 results.append({'name':'ai_configuration','configured':request('GET','/v1/capabilities')[1]['ai']['configured'],'reportSource':report.get('source')})
finally:
 if token:
  status,_=request('DELETE','/v1/account');results.append({'name':'account_cleanup','passed':status==200})
  results.append({'name':'token_revocation','passed':request('GET','/v1/vehicles')[0]==401})
print(json.dumps({'passed':all(r.get('passed',True) for r in results),'checks':results},ensure_ascii=False))
'''
raw=access.run('python3 -c '+shlex.quote(code),timeout=100)
result=json.loads(raw)
p=ROOT/'docs/nas-smoke.json';p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
