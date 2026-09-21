#!/usr/bin/env python3
"""Archive/export Motuo and optionally upload the signed IPA. Never prints credentials."""
from pathlib import Path
import argparse, base64, hashlib, json, os, plistlib, re, shlex, subprocess, urllib.parse, urllib.request

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = 'cn.yundongyl.motuo'

def settings(path):
    result = {}
    if path:
        for line in Path(path).expanduser().read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#') or '=' not in line: continue
            key, value = line.removeprefix('export ').split('=', 1)
            parts = shlex.split(value)
            if len(parts) == 1: result[key.strip()] = parts[0]
    for key in ['APPLE_TEAM_ID', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_PATH']:
        if os.environ.get(key): result[key] = os.environ[key]
    return result

def run(args, log):
    with log.open('w') as output:
        completed = subprocess.run(args, cwd=ROOT/'ios', stdout=output, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise SystemExit(f'Command failed ({completed.returncode}); inspect {log}')

def verify_archive(archive, expected_build):
    app = archive/'Products/Applications/Motuo.app'
    targets = [(app,BUNDLE),(app/'Watch/MotuoWatch.app',BUNDLE+'.watchkitapp')]
    results = []
    for path, identifier in targets:
        info = plistlib.loads((path/'Info.plist').read_bytes())
        if info['CFBundleIdentifier'] != identifier: raise SystemExit('Archive bundle ID mismatch')
        if info['CFBundleVersion'] != expected_build: raise SystemExit('Archive build number mismatch')
        profile = plistlib.loads(subprocess.run(['security','cms','-D','-i',str(path/'embedded.mobileprovision')],capture_output=True,check=True).stdout)
        appIdentifier = profile['Entitlements']['application-identifier']
        if appIdentifier != '7NUGZ3A48C.'+identifier: raise SystemExit('Archive provisioning ID mismatch')
        subprocess.run(['codesign','--verify','--deep','--strict',str(path)],capture_output=True,check=True)
        if not (path/'PrivacyInfo.xcprivacy').exists(): raise SystemExit('Privacy manifest missing from archive')
        if not (path/'Assets.car').exists(): raise SystemExit('App icon assets missing from archive')
        if any(p.suffix.lower() in ['.p8','.pem','.p12','.mobileconfig','.pdf','.jsonl'] or p.name.endswith('.env') for p in path.rglob('*')):
            raise SystemExit('Unexpected private data or credential-like file in archive')
        results.append({'bundleId':identifier,'version':info['CFBundleShortVersionString'],'build':info['CFBundleVersion'],'profile':profile['Name'],'signedIdentifier':appIdentifier,'codeSignatureVerified':True})
    if results[0]['version'] != results[1]['version']: raise SystemExit('Phone/watch version mismatch')
    if not (app/'ThirdPartyNotices.txt').exists(): raise SystemExit('Third-party license notice missing')
    cockpit=app/'Cockpit'
    if not (cockpit/'index.html').exists(): raise SystemExit('Native cockpit missing')
    model=cockpit/'assets/models/suzuki-gsx-r1000/model.glb'
    manifest=json.loads((ROOT/'prototypes/motuo-v2/assets/models/suzuki-gsx-r1000/manifest.json').read_text())
    if hashlib.sha256(model.read_bytes()).hexdigest()!=manifest['sha256']: raise SystemExit('Bundled model checksum mismatch')
    receipt = {'targets':results,'physicalInstallVerified':False}
    (archive.parent/'archive-verification.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps(receipt))

def apple_status(config):
    key = Path(config['ASC_KEY_PATH']).expanduser()
    header = {'alg':'ES256', 'kid':config['ASC_KEY_ID'], 'typ':'JWT'}
    import time
    payload = {'iss':config['ASC_ISSUER_ID'], 'iat':int(time.time()), 'exp':int(time.time())+600, 'aud':'appstoreconnect-v1'}
    def b64(data): return base64.urlsafe_b64encode(data).rstrip(b'=')
    message = b'.'.join(b64(json.dumps(x, separators=(',', ':')).encode()) for x in [header,payload])
    sig = subprocess.run(['openssl','dgst','-sha256','-sign',str(key)], input=message, capture_output=True, check=True).stdout
    # OpenSSL returns a short DER ECDSA sequence: two positive 32-byte integers.
    if sig[0] != 48 or sig[2] != 2: raise ValueError('Unexpected signing response')
    offset = 3; length = sig[offset]; r = sig[offset+1:offset+1+length]; offset += 1+length
    if sig[offset] != 2: raise ValueError('Unexpected signing response')
    length = sig[offset+1]; s = sig[offset+2:offset+2+length]
    token = (message+b'.'+b64(r.lstrip(b'\0').rjust(32,b'\0')+s.lstrip(b'\0').rjust(32,b'\0'))).decode()
    def get(path, params):
        request = urllib.request.Request('https://api.appstoreconnect.apple.com'+path+'?'+urllib.parse.urlencode(params), headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(request, timeout=40) as response: return json.load(response)
    apps = [app for app in get('/v1/apps', {'filter[bundleId]':BUNDLE,'limit':10})['data'] if app['attributes'].get('bundleId') == BUNDLE]
    if not apps: return {'appRecord':False, 'bundleId':BUNDLE, 'builds':[]}
    app = apps[0]
    payload = get('/v1/builds', {'filter[app]':app['id'], 'sort':'-uploadedDate','limit':10,'include':'preReleaseVersion,buildBetaDetail'})
    included = {x['id']:x for x in payload.get('included',[])}
    builds = []
    for item in payload['data']:
        def related(name):
            identifier = (item.get('relationships',{}).get(name,{}).get('data') or {}).get('id')
            return included.get(identifier,{}).get('attributes',{})
        attrs = item['attributes']
        builds.append({'id':item['id'],'buildNumber':attrs.get('version'),'appVersion':related('preReleaseVersion').get('version'),
                       'processingState':attrs.get('processingState'),'internalBuildState':related('buildBetaDetail').get('internalBuildState'),
                       'uploadedDate':attrs.get('uploadedDate'),'expirationDate':attrs.get('expirationDate')})
    return {'appRecord':True,'appId':app['id'],'name':app['attributes']['name'],'bundleId':BUNDLE,'builds':builds}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env', help='Private signing environment file (optional for archive/export)')
    parser.add_argument('--keychain-env',help='Optional existing signing-keychain environment file; unlocks without changing access permissions')
    parser.add_argument('--archive', action='store_true')
    parser.add_argument('--export', action='store_true', dest='export_')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--upload', action='store_true')
    parser.add_argument('--build-number', default='1')
    parser.add_argument('--build-dir',type=Path,default=Path.home()/'Library/Developer/MotuoBuilds',help='Build outside iCloud/FileProvider folders to prevent FinderInfo signing failures')
    args = parser.parse_args(); config = settings(args.env)
    if args.keychain_env and (args.archive or args.export_):
        keychain_config = settings(args.keychain_env)
        name = keychain_config.get('MOTUO_SIGNING_KEYCHAIN') or keychain_config.get('AIPODCAST_SIGNING_KEYCHAIN')
        password = keychain_config.get('MOTUO_SIGNING_KEYCHAIN_PASSWORD') or keychain_config.get('AIPODCAST_SIGNING_KEYCHAIN_PASSWORD')
        if not name or not password: parser.error('Signing keychain configuration incomplete')
        unlocked = subprocess.run(['security','unlock-keychain','-p',password,str(Path(name).expanduser())],capture_output=True)
        if unlocked.returncode: raise SystemExit('Existing signing keychain could not be unlocked; no permissions were changed.')
    if not re.fullmatch(r'\d+(\.\d+){0,2}', args.build_number): parser.error('Invalid build number')
    build = args.build_dir.expanduser().resolve(); build.mkdir(parents=True, exist_ok=True)
    archive = build/'Motuo.xcarchive'; exported = build/'export'
    if args.archive:
        subprocess.run(['python3',str(ROOT/'scripts/prepare-native-cockpit.py')],check=True)
        run(['xcodegen','generate'], build/'generate.log')
        run(['xcodebuild','-project','Motuo.xcodeproj','-scheme','Motuo','-configuration','Release','-destination','generic/platform=iOS','-derivedDataPath',str(build/'ReleaseDerivedData'),'-archivePath',str(archive),'CURRENT_PROJECT_VERSION='+args.build_number,'archive'], build/'archive.log')
        print('Signed archive: '+str(archive))
        verify_archive(archive, args.build_number)
    if args.export_:
        options = {'method':'app-store-connect','destination':'export','teamID':config.get('APPLE_TEAM_ID','7NUGZ3A48C'),'signingStyle':'manual','stripSwiftSymbols':True,'uploadSymbols':True,'manageAppVersionAndBuildNumber':False,'provisioningProfiles':{BUNDLE:'Motuo App Store',BUNDLE+'.watchkitapp':'Motuo Watch App Store'}}
        path = build/'ExportOptions.plist'; path.write_bytes(plistlib.dumps(options))
        run(['xcodebuild','-exportArchive','-archivePath',str(archive),'-exportOptionsPlist',str(path),'-exportPath',str(exported)], build/'export.log')
        ipa = next(exported.glob('*.ipa'))
        print(json.dumps({'ipa':str(ipa),'bytes':ipa.stat().st_size,'sha256':hashlib.sha256(ipa.read_bytes()).hexdigest()}))
    if args.status or args.upload:
        for key in ['ASC_KEY_ID','ASC_ISSUER_ID','ASC_KEY_PATH']:
            if not config.get(key): parser.error('Missing '+key)
        status = apple_status(config)
        print(json.dumps(status, ensure_ascii=False))
        (build/'apple-status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2))
        if args.upload:
            if not status['appRecord']: raise SystemExit('Create the Motuo app record in App Store Connect before upload.')
            ipa = next(exported.glob('*.ipa'))
            run(['xcrun','altool','--upload-app','-f',str(ipa),'--api-key',config['ASC_KEY_ID'],'--api-issuer',config['ASC_ISSUER_ID'],'--p8-file-path',str(Path(config['ASC_KEY_PATH']).expanduser())], build/'upload.log')
            print('Upload completed. Check --status for Apple processing; upload is not TestFlight availability.')

if __name__ == '__main__': main()
