#!/usr/bin/env python3
"""Temporarily run a known prior Motuo image, then restore the final release.
Requires no ongoing uploads or processing jobs. Never touches other projects.
"""
import argparse, datetime, fcntl, json, os, pathlib, subprocess, time, urllib.request
ROOT=pathlib.Path('/volume1/docker/motuo');D='/usr/local/bin/docker'
parser=argparse.ArgumentParser();parser.add_argument('--previous',required=True);args=parser.parse_args()
if not all(c.isalnum() or c=='-' for c in args.previous):raise ValueError('Invalid release')
lock=(ROOT/'deployment.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
original=(ROOT/'.env').read_text()
values=dict(line.split('=',1) for line in original.splitlines() if '=' in line)
final=values['MOTUO_RELEASE'].strip("'\"")
if final==args.previous:raise ValueError('Prior release must differ')
compose=ROOT/'releases'/final/'deploy/compose.nas.yml'

def run(command):
 p=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
 if p.returncode:raise RuntimeError('COMMAND_FAILED_'+str(p.returncode))
 return p.stdout

def sql(query):return run([D,'exec','motuo-postgres','psql','-U','motuo','-d','motuo','-At','-c',query]).decode().strip()
def fingerprints():
 result={}
 for table in sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines():
  if not table.replace('_','').isalnum():raise RuntimeError('UNEXPECTED_TABLE')
  result[table]=sql('SELECT md5(coalesce(string_agg(row_to_json(t)::text,E\'\\n\' ORDER BY row_to_json(t)::text),\'\')) FROM public."'+table+'" t')
 return result

def health():
 for _ in range(60):
  try:
   with urllib.request.urlopen('http://127.0.0.1:3020/healthz',timeout=2) as r:
    value=json.loads(r.read())
    if r.status==200:return value
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('HEALTH_TIMEOUT')

def images():
 return {name:json.loads(run([D,'inspect',name]))[0]['Image'] for name in ['motuo-api','motuo-worker']}

def apply(release):
 text='\n'.join(line for line in original.splitlines() if not line.startswith('MOTUO_RELEASE='))+'\nMOTUO_RELEASE='+release+'\n'
 tmp=ROOT/'.env.rollback-stage';tmp.write_text(text);os.chmod(tmp,0o600);tmp.replace(ROOT/'.env')
 run([D,'compose','--env-file',str(ROOT/'.env'),'-f',str(compose),'up','-d','--no-build','--pull','never','api','worker'])
 return health()

pending=int(sql("SELECT (SELECT count(*) FROM manuals WHERE status IN ('queued','processing','uploading'))+(SELECT count(*) FROM reports WHERE status IN ('pending','processing'))"))
if pending:raise RuntimeError('WAIT_FOR_UPLOADS_AND_JOBS')
result={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'finalRelease':final,'previousRelease':args.previous,'status':'running'}
before=fingerprints();result['finalImagesBefore']=images()
try:
 result['priorHealth']=apply(args.previous);result['priorImages']=images()
 result['priorDataUnchanged']=fingerprints()==before
 if not result['priorDataUnchanged']:raise RuntimeError('DATA_CHANGED_DURING_ROLLBACK')
finally:
 result['restoredHealth']=apply(final);result['finalImagesAfter']=images()
 result['finalDataUnchanged']=fingerprints()==before
 result['restoredFinalImages']=result['finalImagesBefore']==result['finalImagesAfter']
 result['status']='passed' if result.get('priorDataUnchanged') and result['finalDataUnchanged'] and result['restoredFinalImages'] else 'failed'
 result['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 out=ROOT/'rollback-verification.json';out.write_text(json.dumps(result,indent=2)+'\n');os.chmod(out,0o600)
 print(json.dumps(result))
