#!/usr/bin/env python3
"""Check Motuo DNS or issue its isolated certificate using the existing ACME account."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get('MOTUO_EDGE_SSH_HOST')
if not HOST: raise SystemExit('Set MOTUO_EDGE_SSH_HOST to your shared edge server SSH target (e.g. user@203.0.113.1).')
DOMAIN = os.environ.get('MOTUO_EDGE_DOMAIN', 'motuo.example.com')
EXPECTED_IP = os.environ.get('MOTUO_EDGE_IP')
if not EXPECTED_IP: raise SystemExit('Set MOTUO_EDGE_IP to your shared edge server public IP.')
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST]

PROBE = r'''
import json, socket, subprocess
domain = "__DOMAIN__"
try:
    addresses = sorted(set(x[4][0] for x in socket.getaddrinfo(domain, 80, type=socket.SOCK_STREAM)))
except socket.gaierror:
    addresses = []
print(json.dumps({'domain':domain, 'addresses':addresses, 'ready':addresses == ["__EXPECTED_IP__"]}))
'''.replace('__DOMAIN__', DOMAIN).replace('__EXPECTED_IP__', EXPECTED_IP)

ISSUE = r'''
import json, pathlib, subprocess
root = pathlib.Path('/opt/MedAgent_OS/certbot/conf')
accounts = root / 'accounts/acme-v02.api.letsencrypt.org/directory'
existing = [p.name for p in accounts.iterdir() if p.is_dir() and (p/'regr.json').is_file()] if accounts.exists() else []
if len(existing) != 1:
    raise SystemExit('Expected one existing production ACME account; inspect account selection before continuing.')
command = ['docker','exec','medagent-certbot','certbot','certonly','--non-interactive',
    '--webroot','--webroot-path','/var/www/certbot','--cert-name','__DOMAIN__',
    '-d','__DOMAIN__','--keep-until-expiring','--account',existing[0]]
# No --agree-tos: a new account or changed legal agreement needs a separate decision.
subprocess.run(command, check=True)
cert = root / 'live/__DOMAIN__/fullchain.pem'
subprocess.run(['openssl','x509','-in',str(cert),'-noout','-checkhost','__DOMAIN__'],check=True)
'''.replace('__DOMAIN__', DOMAIN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Issue certificate and activate the marked Motuo HTTPS block')
    args = parser.parse_args()
    probe = subprocess.run(SSH + ['python3 -c ' + shlex.quote(PROBE)], check=True, capture_output=True, text=True)
    evidence = json.loads(probe.stdout)
    print(json.dumps(evidence))
    if not evidence['ready']:
        raise SystemExit('DNS must resolve only to '+EXPECTED_IP+' before certificate issuance; no change made.')
    if not args.apply:
        return
    subprocess.run(SSH + ['sudo -n python3 -c ' + shlex.quote(ISSUE)], check=True)
    subprocess.run([sys.executable, str(ROOT/'scripts/deploy-edge.py'), 'https', '--apply'], check=True)
    # TLS remains verified; there is deliberately no insecure-certificate fallback.
    subprocess.run(SSH + ['curl --fail --silent --show-error --max-time 15 https://'+DOMAIN+'/healthz'], check=True)


if __name__ == '__main__':
    main()
