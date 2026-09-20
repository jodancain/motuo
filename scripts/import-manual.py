#!/usr/bin/env python3
"""Resume a manual import on an existing paired Motuo service. Credentials stay in a private state file."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, math, os, time, urllib.parse, urllib.request, urllib.error, uuid
ROOT = Path(__file__).resolve().parents[1]
SIZE = 4*1024*1024

def save(path, state):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as out: json.dump(state,out,ensure_ascii=False,indent=2)
    os.chmod(path,0o600)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state',type=Path,required=True)
    parser.add_argument('--pdf',type=Path,required=True)
    parser.add_argument('--base-url',help='HTTPS endpoint or localhost SSH tunnel')
    parser.add_argument('--questions',action='store_true')
    parser.add_argument('--reference-jsonl',type=Path)
    args=parser.parse_args(); state=json.loads(args.state.read_text())
    base=args.base_url or state['baseURL']; url=urllib.parse.urlparse(base)
    if url.scheme!='https' and not (url.scheme=='http' and url.hostname in ['127.0.0.1','localhost','::1']): raise SystemExit('Use HTTPS or a localhost SSH tunnel')
    if url.username or url.password: raise SystemExit('Credentials in URLs are forbidden')
    def request(method,path,body=None,raw=None,headers=None,retry=False):
        data=json.dumps(body,ensure_ascii=False).encode() if body is not None else raw
        hs={'Authorization':'Bearer '+state['token'],'Content-Type':'application/json' if body is not None else 'application/octet-stream',**(headers or {})}
        for attempt in range(5 if retry else 1):
            try:
                with urllib.request.urlopen(urllib.request.Request(base+path,method=method,data=data,headers=hs),timeout=120) as response:
                    payload=response.read()
                    return json.loads(payload) if 'application/json' in response.headers.get('Content-Type','') else payload
            except urllib.error.HTTPError as error:
                if not retry or error.code not in [429,500,502,503,504] or attempt==4: raise RuntimeError('HTTP '+str(error.code)+' for '+path) from None
            except (urllib.error.URLError,TimeoutError):
                if not retry or attempt==4: raise
            time.sleep(min(2**attempt,8))
    size=args.pdf.stat().st_size
    if not 0<size<=256*1024*1024: raise SystemExit('PDF must be 1 byte to 256 MiB')
    sha=hashlib.sha256()
    with args.pdf.open('rb') as source:
        for chunk in iter(lambda:source.read(SIZE),b''):sha.update(chunk)
    digest=sha.hexdigest()
    if not state.get('vehicleId'):
        state['vehicleId']=str(uuid.uuid4()); state['vehicleCreatePending']=True; save(args.state,state)
    if state.get('vehicleCreatePending'):
        request('PUT','/v1/vehicles/'+state['vehicleId'],{'id':state['vehicleId'],'name':'我的 GSX250R','make':'SUZUKI','model':'GSX250R','year':None,'abs':None,'displacementCC':248,'plate':'','tyres':'','modifications':'','odometerKM':0},retry=True)
        state['vehicleCreatePending']=False; save(args.state,state)
    imports=state.setdefault('imports',{}); ticket=imports.get(digest)
    if not ticket:
        ticket=request('POST','/v1/manuals',{'vehicleId':state['vehicleId'],'fileName':args.pdf.name,'totalBytes':size,'sha256':digest})
        imports[digest]=ticket; save(args.state,state)
    manualId=ticket['id']; path='/v1/manuals/'+manualId
    current=request('GET',path,retry=True)
    started=time.monotonic(); chunks=math.ceil(size/SIZE)
    if current['status']=='uploading':
        with args.pdf.open('rb') as source:
            for sequence in range(chunks):
                chunk=source.read(SIZE)
                request('PUT',path+'/chunks/'+str(sequence),raw=chunk,headers={'X-Content-SHA256':hashlib.sha256(chunk).hexdigest()},retry=True)
                print(json.dumps({'uploaded':sequence+1,'chunks':chunks}),flush=True)
        request('POST',path+'/complete',{'expectedChunks':chunks},retry=True)
    deadline=time.monotonic()+1800
    while time.monotonic()<deadline:
        current=request('GET',path,retry=True)
        print(json.dumps({'manualStatus':current['status'],'progress':current['progress'],'pages':current['pageCount']}),flush=True)
        if current['status']=='ready':break
        if current['status'] in ['failed','deleted']:raise RuntimeError('Manual processing did not complete')
        time.sleep(15)
    if current['status']!='ready':raise RuntimeError('Manual processing timed out; rerun to resume')
    remote=request('GET',path+'/file',headers={'Range':'bytes=0-1023'},retry=True)
    with args.pdf.open('rb') as source: assert remote==source.read(1024),'Authenticated original Range mismatch'
    report={'sourceBytes':size,'sourceSHA256':digest,'manualId':manualId,'vehicleId':state['vehicleId'],'uploadedChunks':chunks,'manualStatus':current,'elapsedSeconds':round(time.monotonic()-started,2),'rangePassed':True,'transport':'HTTPS' if url.scheme=='https' else 'SSH local tunnel to NAS','questions':[]}
    if args.questions:
        spec=importlib.util.spec_from_file_location('manual_evidence',ROOT/'scripts/manual-e2e.py'); scoring=importlib.util.module_from_spec(spec); spec.loader.exec_module(scoring)
        fixture=json.loads((ROOT/'fixtures/manual-questions.json').read_text())
        assert digest==fixture['sourceSha256'],'Fixture does not match PDF'
        pages={p['page']:p for p in map(json.loads,args.reference_jsonl.read_text().splitlines())} if args.reference_jsonl else {}
        for question in fixture['questions']:
            response=request('POST','/v1/manuals/ask',{'vehicleId':state['vehicleId'],'question':question['question']})
            if question['expectedBehavior']=='cited_answer':
                score=scoring.score_question(question,response)
                alternative=scoring.REVIEWED_ALTERNATIVES.get(question['id'])
                alt=bool(alternative and any(c['page']==alternative['page'] and c['printedPage']==alternative['printedPage'] and alternative['quote'] in c['quote'] for c in response.get('citations',[])))
                integrity=bool(pages and response.get('citations')) and all(c['manualId']==manualId and c['quote'] in pages.get(c['page'],{}).get('text','') for c in response.get('citations',[]))
                score.update({'reviewedAlternative':alt,'citationReferenceIntegrity':integrity,'evidencePass':integrity and (score['strictPass'] or alt)})
            else: score={'id':question['id'],'boundaryPass':response.get('source')=='no_evidence' and not response.get('citations')}
            report['questions'].append(score); print(json.dumps({'question':question['id'],'passed':score.get('evidencePass',score.get('boundaryPass'))}),flush=True)
            time.sleep(4)
    destination=ROOT/'.private/nas-manual-report.json'; save(destination,report)
    print(json.dumps({'manualReady':True,'pages':current['pageCount'],'rangePassed':True,'report':str(destination),'evidencePasses':sum(x.get('evidencePass',False) for x in report['questions']),'boundaryPasses':sum(x.get('boundaryPass',False) for x in report['questions'])}),flush=True)

if __name__=='__main__':main()
