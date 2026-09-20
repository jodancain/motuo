#!/usr/bin/env python3
"""Back up Motuo, restore to an isolated disposable PostgreSQL, verify all rows/files.
Run as NAS administrator only after Motuo health is confirmed. Does not alter any other project.
"""
import datetime, hashlib, json, os, pathlib, secrets, shutil, subprocess, tarfile, time
ROOT=pathlib.Path('/volume1/docker/motuo'); D='/usr/local/bin/docker'
STAMP=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
BACKUP=ROOT/'backups'/STAMP; CHECK=ROOT/'restore-check'/STAMP
NAME='motuo-restore-'+STAMP.lower(); PAUSED=[]

def run(args,stdin=None,timeout=120):
    p=subprocess.run(args,input=stdin,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if p.returncode:raise RuntimeError('COMMAND_FAILED_'+pathlib.Path(args[0]).name+'_'+str(p.returncode))
    return p.stdout

def inspect(name):
    p=subprocess.run([D,'inspect',name],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    return json.loads(p.stdout)[0] if p.returncode==0 else None

def sql(container,query):return run([D,'exec',container,'psql','-U','motuo','-d','motuo','-At','-c',query]).decode().strip()

def db_fingerprint(container):
    tables=sql(container,"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines(); result={}
    for table in tables:
        if not table.replace('_','').isalnum():raise RuntimeError('UNEXPECTED_TABLE_NAME')
        query='SELECT json_build_object(\'rows\',count(*),\'hash\',md5(coalesce(string_agg(row_to_json(t)::text,E\'\\n\' ORDER BY row_to_json(t)::text),\'\'))) FROM public."'+table+'" t'
        result[table]=json.loads(sql(container,query))
    return result

def files(root):
    result={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink():raise RuntimeError('SYMLINK_NOT_BACKED_UP')
        if p.is_file():
            h=hashlib.sha256()
            with p.open('rb') as f:
                for block in iter(lambda:f.read(4*1024*1024),b''):h.update(block)
            result[str(p.relative_to(root))]={'bytes':p.stat().st_size,'sha256':h.hexdigest()}
    return result

def write_json(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');os.chmod(path,0o600)

BACKUP.mkdir(mode=0o700,parents=True,exist_ok=False); CHECK.mkdir(mode=0o700,parents=True,exist_ok=False)
result={'startedAt':STAMP,'backupPath':str(BACKUP),'restoreContainer':NAME,'status':'running'}
write_json(BACKUP/'verification.json',result)
try:
    for name in ['motuo-worker','motuo-api']:
        info=inspect(name)
        if info and info['State']['Running'] and not info['State'].get('Paused'):
            run([D,'pause',name]);PAUSED.append(name)
    try:
        before=db_fingerprint('motuo-postgres');manifest=files(ROOT/'data')
        dump=run([D,'exec','motuo-postgres','pg_dump','-U','motuo','-d','motuo','--format=custom'],timeout=180)
        (BACKUP/'database.dump').write_bytes(dump);os.chmod(BACKUP/'database.dump',0o600)
        with tarfile.open(BACKUP/'data.tar.gz','w:gz') as tar:
            tar.add(ROOT/'data',arcname='data',recursive=True)
        os.chmod(BACKUP/'data.tar.gz',0o600)
        shutil.copy2(ROOT/'.env',BACKUP/'runtime.env');os.chmod(BACKUP/'runtime.env',0o600)
        images={name:inspect(name)['Image'] for name in ['motuo-postgres','motuo-api','motuo-worker'] if inspect(name)}
        write_json(BACKUP/'manifest.json',{'database':before,'files':manifest,'images':images,'dumpSHA256':hashlib.sha256(dump).hexdigest()})
    finally:
        for name in reversed(PAUSED):run([D,'unpause',name])
        PAUSED=[]
    # The restore database has no network interface or published ports.
    (CHECK/'postgres').mkdir(mode=0o700)
    run([D,'run','-d','--name',NAME,'--network','none','--memory','512m','--label','motuo.restore-test=true','-e','POSTGRES_USER=motuo','-e','POSTGRES_DB=motuo','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','PGDATA=/var/lib/postgresql/data/pgdata','-v',str(CHECK/'postgres')+':/var/lib/postgresql/data','pgvector/pgvector:pg18'])
    ready=False
    for _ in range(60):
        p=subprocess.run([D,'exec',NAME,'pg_isready','-U','motuo','-d','motuo'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if p.returncode==0:ready=True;break
        time.sleep(1)
    if not ready:raise RuntimeError('RESTORE_DB_NOT_READY')
    run([D,'exec','-i',NAME,'pg_restore','--exit-on-error','--no-owner','-U','motuo','-d','motuo'],stdin=dump,timeout=180)
    restored=db_fingerprint(NAME)
    if restored!=before:raise RuntimeError('DATABASE_RESTORE_MISMATCH')
    with tarfile.open(BACKUP/'data.tar.gz','r:gz') as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk() or member.name.startswith('/') or '..' in pathlib.PurePosixPath(member.name).parts:raise RuntimeError('UNSAFE_BACKUP_MEMBER')
        tar.extractall(CHECK)
    restored_files=files(CHECK/'data')
    if restored_files!=manifest:raise RuntimeError('FILE_RESTORE_MISMATCH')
    result.update({'status':'passed','tablesVerified':len(before),'rowsVerified':sum(v['rows'] for v in before.values()),'filesVerified':len(manifest),'bytesVerified':sum(v['bytes'] for v in manifest.values()),'dumpSHA256':hashlib.sha256(dump).hexdigest(),'images':images})
except Exception as error:
    result.update({'status':'failed','errorType':type(error).__name__,'error':str(error) if str(error).isupper() or str(error).startswith(('COMMAND_FAILED','DATABASE_','FILE_','RESTORE_','SYMLINK_','UNSAFE_')) else 'Verification failed'})
finally:
    for name in reversed(PAUSED):
        try:run([D,'unpause',name])
        except Exception:pass
    if inspect(NAME):
        run([D,'rm','-f',NAME]);result['restoreContainerRemoved']=True
    # Only this uniquely created disposable restore directory is removed; backups are retained.
    shutil.rmtree(CHECK)
    result['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(BACKUP/'verification.json',result)
    print(json.dumps(result,ensure_ascii=False))
