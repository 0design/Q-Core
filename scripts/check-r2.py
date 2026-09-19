"""Verify CI -> private S3 API -> public Registry, leaving no probe behind."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.request import urlopen
from urllib.error import URLError, HTTPError
import uuid


def check():
    required = ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'R2_ENDPOINT',
                'R2_BUCKET', 'REGISTRY_PUBLIC_URL')
    if any(not os.environ.get(name) for name in required):
        raise RuntimeError('Missing R2 configuration')
    endpoint = os.environ['R2_ENDPOINT'].rstrip('/')
    public = os.environ['REGISTRY_PUBLIC_URL'].rstrip('/')
    if not endpoint.startswith('https://') or not public.startswith('https://'):
        raise RuntimeError('HTTPS required')
    bucket = os.environ['R2_BUCKET']
    key = '_checks/' + uuid.uuid4().hex + '.json'
    payload = (json.dumps({'purpose': 'registry-connectivity-check',
                          'commit': os.environ.get('GITHUB_SHA', 'local'),
                          'nonce': uuid.uuid4().hex}, sort_keys=True) + '\n').encode()

    def s3(*args):
        result = subprocess.run(['aws', '--endpoint-url', endpoint, '--region', 'auto',
                                 '--no-cli-pager', 's3api', *args],
                                capture_output=True, timeout=60)
        if result.returncode:
            # Never echo credentials or full provider responses into CI logs.
            raise RuntimeError('R2 operation failed: ' + args[0])
        return result.stdout

    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'probe.json'
        downloaded = Path(directory) / 'downloaded.json'
        source.write_bytes(payload)
        try:
            s3('put-object', '--bucket', bucket, '--key', key, '--body', str(source),
               '--content-type', 'application/json', '--cache-control', 'no-store')
            s3('get-object', '--bucket', bucket, '--key', key, str(downloaded))
            if downloaded.read_bytes() != payload:
                raise RuntimeError('Private read checksum mismatch')
            print('R2 write and private read: passed', flush=True)
            for attempt in range(6):
                try:
                    with urlopen(public + '/' + key, timeout=20) as response:
                        if response.read(len(payload) + 1) != payload:
                            raise RuntimeError('Public read checksum mismatch')
                    break
                except URLError as error:
                    if isinstance(error, HTTPError):
                        print(json.dumps({'publicStatus': error.code,
                                          'server': error.headers.get('server'),
                                          'mitigation': error.headers.get('cf-mitigated')}), flush=True)
                    else:
                        print('Public connection failed: ' + type(error.reason).__name__, flush=True)
                    if attempt == 5:
                        raise RuntimeError('Public Registry did not serve the probe') from None
                    time.sleep(5)
        finally:
            s3('delete-object', '--bucket', bucket, '--key', key)
            print('R2 probe cleanup: passed', flush=True)
    print(json.dumps({'bucket': bucket, 'publicOrigin': public,
                      'write': 'passed', 'privateRead': 'passed',
                      'publicRead': 'passed', 'cleanup': 'passed',
                      'sha256': hashlib.sha256(payload).hexdigest()}))


if __name__ == '__main__':
    check()
