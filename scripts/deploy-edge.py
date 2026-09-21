#!/usr/bin/env python3
"""Add/update only the marked Motuo Nginx block with CAS, backup, validation and reload."""
from pathlib import Path
import argparse, hashlib, json, os, subprocess

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get('MOTUO_EDGE_SSH_HOST')
if not HOST: raise SystemExit('Set MOTUO_EDGE_SSH_HOST to your shared edge server SSH target (e.g. user@203.0.113.1).')
DOMAIN = os.environ.get('MOTUO_EDGE_DOMAIN', 'motuo.example.com')
CONFIG = '/opt/MedAgent_OS/nginx.conf'
REMOTE = r'''
import datetime, fcntl, hashlib, json, os, pathlib, subprocess, sys
p = json.load(sys.stdin)
path = pathlib.Path('/opt/MedAgent_OS/nginx.conf')
lock = open('/opt/MedAgent_OS/.motuo-nginx.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
old = path.read_bytes()
if hashlib.sha256(old).hexdigest() != p['expectedSHA256']: raise SystemExit('Shared config changed; read a fresh baseline.')
new = p['candidate'].encode()
if old == new:
    print(json.dumps({'changed':False,'sha256':p['expectedSHA256']})); sys.exit(0)
directory = path.parent / '.motuo-backups'; directory.mkdir(mode=0o700, exist_ok=True)
backup = directory / ('nginx.'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'.'+p['expectedSHA256'][:12]+'.conf')
backup.write_bytes(old); backup.chmod(0o600)
def write(data):
    # This file is bind-mounted into the running Nginx container. Keep its inode.
    with path.open('r+b') as output:
        output.seek(0); output.write(data); output.truncate(); output.flush(); os.fsync(output.fileno())
def command(*args):
    return subprocess.run(['docker','exec','medagent-nginx',*args],capture_output=True,text=True)
write(new)
test = command('nginx','-t')
if test.returncode:
    if path.read_bytes() == new: write(old)
    print(test.stderr, file=sys.stderr); raise SystemExit('Candidate rejected; original restored before reload.')
reload = command('nginx','-s','reload')
if reload.returncode:
    if path.read_bytes() == new: write(old); command('nginx','-t'); command('nginx','-s','reload')
    raise SystemExit('Reload failed; original restored.')
print(json.dumps({'changed':True,'backup':str(backup),'sha256':hashlib.sha256(new).hexdigest(),'nginxTest':True,'reload':True}))
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['http','https'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    ssh = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',HOST]
    old = subprocess.run(ssh+['sudo -n cat '+CONFIG],capture_output=True,check=True).stdout.decode()
    block = (ROOT/'deploy'/('nginx-'+args.mode+'.conf')).read_text().rstrip()
    begin = '# BEGIN motuo-example'; end = '# END motuo-example'
    if begin in old:
        if old.count(begin) != 1 or old.count(end) != 1: raise SystemExit('Ambiguous Motuo block')
        a = old.index(begin); b = old.index(end,a)+len(end)
        candidate = old[:a]+block+old[b:]
    else:
        if end in old or 'server_name '+DOMAIN in old: raise SystemExit('Unmarked Motuo host exists; inspect first')
        candidate = old.rstrip()+'\n\n'+block+'\n'
    evidence = ROOT/'.private/edge'; evidence.mkdir(mode=0o700,parents=True,exist_ok=True)
    (evidence/'candidate.conf').write_text(candidate)
    if not args.apply:
        print(json.dumps({'mode':args.mode,'candidate':str(evidence/'candidate.conf'),'changed':old != candidate})); return
    if args.mode == 'https':
        subprocess.run(ssh+['sudo -n test -s /opt/MedAgent_OS/certbot/conf/live/'+DOMAIN+'/fullchain.pem'],check=True)
    import shlex
    result = subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(REMOTE)],input=json.dumps({'expectedSHA256':hashlib.sha256(old.encode()).hexdigest(),'candidate':candidate}),capture_output=True,text=True)
    if result.returncode: raise SystemExit(result.stderr or result.stdout)
    print(result.stdout.strip()); (evidence/(args.mode+'-receipt.json')).write_text(result.stdout)

if __name__ == '__main__': main()
