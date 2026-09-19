"""Publish a verified static Registry; current moves only after public verification."""
import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.request import urlopen


def sha(body):
    return hashlib.sha256(body).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def export_files(directory):
    root = Path(directory)
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlink in export')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            if not re.fullmatch(r'[A-Za-z0-9_./-]+', name):
                raise ValueError('Unsafe export name')
            files[name] = path.read_bytes()
    sums = {}
    for line in files['SHA256SUMS'].decode().splitlines():
        digest, name = line.split('  ', 1)
        if name in sums or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid checksum manifest')
        sums[name] = digest
    if set(sums) != set(files) - {'SHA256SUMS'}:
        raise ValueError('Unlisted or missing export file')
    if any(sha(files[name]) != digest for name, digest in sums.items()):
        raise ValueError('Export checksum mismatch')
    catalog = json.loads(files['catalog.json'])
    core = catalog['core']
    if sha(files[core['artifact']]) != core['artifactSha256']:
        raise ValueError('Core pin mismatch')
    return files, catalog


class R2:
    def __init__(self):
        self.endpoint = os.environ['R2_ENDPOINT']
        self.bucket = os.environ['R2_BUCKET']
        self.public = os.environ['REGISTRY_PUBLIC_URL'].rstrip('/')
        if not self.endpoint.startswith('https://') or not self.public.startswith('https://'):
            raise ValueError('HTTPS required')

    def command(self, *args):
        result = subprocess.run(['aws', '--endpoint-url', self.endpoint, '--region', 'auto',
                                 '--no-cli-pager', 's3api', *args], capture_output=True, timeout=120)
        if result.returncode:
            # Do not emit provider responses or credentials.
            if b'(NoSuchKey)' in result.stderr or b'(404)' in result.stderr:
                raise FileNotFoundError(args[0])
            raise RuntimeError('R2 operation failed: ' + args[0])
        return json.loads(result.stdout or '{}')

    def read(self, key):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'object'
            try:
                metadata = self.command('get-object', '--bucket', self.bucket, '--key', key, str(path))
                return path.read_bytes(), metadata['ETag']
            except FileNotFoundError:
                return None, None

    def put(self, key, body, etag=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'object'
            path.write_bytes(body)
            condition = ['--if-match', etag] if etag else ['--if-none-match', '*']
            self.command('put-object', '--bucket', self.bucket, '--key', key, '--body', str(path),
                         '--content-type', mimetypes.guess_type(key)[0] or 'application/octet-stream',
                         '--cache-control', 'no-store' if key == 'current.json' else 'public,max-age=31536000,immutable',
                         *condition)

    def verify_public(self, key, body):
        with urlopen(self.public + '/' + key, timeout=30) as response:
            if response.read(len(body) + 1) != body:
                raise ValueError('Public bytes mismatch: ' + key)


def immutable(store, key, body):
    old, _ = store.read(key)
    if old is not None:
        if old != body:
            raise ValueError('Immutable object conflict: ' + key)
    else:
        store.put(key, body)
    if store.read(key)[0] != body:
        raise ValueError('Private bytes mismatch: ' + key)
    store.verify_public(key, body)


def publish(store, directory, commit):
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('Full commit required')
    files, catalog = export_files(directory)
    version = catalog['releaseVersion']
    if not re.fullmatch('[a-zA-Z0-9.-]+', version):
        raise ValueError('Invalid release version')
    prefix = f'releases/{version}/{commit}'
    pointer = {'schemaVersion': 1, 'releaseVersion': version, 'commit': commit,
               'base': store.public + '/' + prefix, 'catalog': prefix + '/catalog.json', 'catalogSha256': sha(files['catalog.json']),
               'coreVersion': catalog['core']['version']}
    # Descriptor is written last; its existence means the complete set was verified.
    for name, body in files.items():
        immutable(store, prefix + '/' + name, body)
    immutable(store, prefix + '/release.json', encode(pointer))
    return pointer


def promote(store, descriptor):
    if not re.fullmatch(r'releases/[a-zA-Z0-9.-]+/[a-f0-9]{40}/release.json', descriptor):
        raise ValueError('Invalid release descriptor')
    body, _ = store.read(descriptor)
    if body is None:
        raise ValueError('Release descriptor missing')
    pointer = json.loads(body)
    prefix = descriptor.rsplit('/', 1)[0]
    if (pointer['schemaVersion'] != 1 or pointer['base'] != store.public + '/' + prefix
            or pointer['commit'] != prefix.rsplit('/', 1)[1]
            or pointer['releaseVersion'] != prefix.split('/')[1]):
        raise ValueError('Release origin mismatch')
    if 'candidate' in pointer['releaseVersion'].lower():
        raise ValueError('Candidate cannot become current')
    # Recheck all published bytes for promotions and rollbacks alike.
    sums, _ = store.read(prefix + '/SHA256SUMS')
    store.verify_public(prefix + '/SHA256SUMS', sums)
    hashes = {}
    for line in sums.decode().splitlines():
        digest, name = line.split('  ', 1)
        if not re.fullmatch(r'[A-Za-z0-9_/-]+(?:\.[A-Za-z0-9_-]+)*', name) or '..' in name:
            raise ValueError('Unsafe manifest path')
        asset, _ = store.read(prefix + '/' + name)
        if asset is None or sha(asset) != digest:
            raise ValueError('Published checksum mismatch')
        if name in hashes or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('Invalid published manifest')
        hashes[name] = digest
        store.verify_public(prefix + '/' + name, asset)
    if hashes.get('catalog.json') != pointer['catalogSha256']:
        raise ValueError('Catalog pointer mismatch')
    catalog = json.loads(store.read(prefix + '/catalog.json')[0])
    if (catalog['releaseVersion'] != pointer['releaseVersion']
            or catalog['core']['version'] != pointer['coreVersion']
            or hashes.get(catalog['core']['artifact']) != catalog['core']['artifactSha256']):
        raise ValueError('Release identity or Core mismatch')
    store.verify_public(descriptor, body)
    old, etag = store.read('current.json')
    if old == body:
        store.verify_public('current.json', body)
        return pointer
    if old is not None:
        immutable(store, 'history/' + sha(old) + '.json', old)
    store.put('current.json', body, etag)
    if store.read('current.json')[0] != body:
        raise ValueError('Current private verification failed')
    store.verify_public('current.json', body)
    return pointer


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['publish', 'promote', 'rollback'])
    parser.add_argument('--directory')
    parser.add_argument('--commit')
    parser.add_argument('--descriptor')
    args = parser.parse_args()
    store = R2()
    result = publish(store, args.directory, args.commit) if args.action == 'publish' else promote(store, args.descriptor)
    print(json.dumps(result))
