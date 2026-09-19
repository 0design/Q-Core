"""Exercise real R2 publisher semantics under a disposable _checks namespace."""
import importlib.util
import json
from pathlib import Path
import tempfile
import uuid

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-registry.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProbeR2(p.R2):
    def __init__(self):
        super().__init__()
        self.prefix = '_checks/publisher-' + uuid.uuid4().hex + '/'
        self.origin = self.public
        self.public += '/' + self.prefix.rstrip('/')
        self.written = set()

    def read(self, key):
        return super().read(self.prefix + key)

    def put(self, key, body, etag=None):
        self.written.add(key)
        super().put(self.prefix + key, body, etag)

    def cleanup(self):
        failures = []
        for key in self.written:
            try:
                self.command('delete-object', '--bucket', self.bucket, '--key', self.prefix + key)
            except Exception:
                failures.append(key)
        if failures:
            raise RuntimeError('Probe cleanup incomplete: ' + self.prefix)


def fixture(directory, version):
    core = b'publisher-test-fixture-not-a-product-package\n'
    catalog = {'releaseVersion': version, 'core': {'version': 'test', 'artifact': 'vendor/test.tgz',
                                                'artifactSha256': p.sha(core)}}
    files = {'catalog.json': p.encode(catalog), 'vendor/test.tgz': core}
    for name, body in files.items():
        path = Path(directory) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    (Path(directory) / 'SHA256SUMS').write_text(''.join(f'{p.sha(body)}  {name}\n' for name, body in files.items()))


def check():
    store = ProbeR2()
    try:
        with tempfile.TemporaryDirectory() as directory:
            fixture(directory, 'publisher-check.1')
            first = p.publish(store, directory, 'a' * 40)
            descriptor = first['catalog'].replace('catalog.json', 'release.json')
            p.promote(store, descriptor)
            first_bytes, old_etag = store.read('current.json')
            fixture(directory, 'publisher-check.2')
            second = p.publish(store, directory, 'b' * 40)
            p.promote(store, second['catalog'].replace('catalog.json', 'release.json'))
            try:
                store.put('current.json', first_bytes, old_etag)
            except RuntimeError:
                pass
            else:
                raise RuntimeError('R2 accepted stale conditional write')
            p.promote(store, descriptor)
            if store.read('current.json')[0] != first_bytes:
                raise RuntimeError('Rollback did not restore exact pointer')
            try:
                store.put('current.json', b'invalid overwrite')
            except RuntimeError:
                pass
            else:
                raise RuntimeError('R2 accepted If-None-Match overwrite')
        print(json.dumps({'scope': 'disposable publisher fixture; no production promotion',
                          'prefix': store.prefix, 'publish': 'passed', 'publicVerification': 'passed',
                          'conditionalWrite': 'passed', 'rollback': 'passed'}))
    finally:
        store.cleanup()
        print('Publisher probe cleanup: passed')


if __name__ == '__main__':
    check()
