import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).parents[1] / 'scripts/publish-registry.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class MemoryR2:
    public = 'https://registry.example.test'

    def __init__(self):
        self.objects = {}
        self.failed_public = None
        self.race = False

    def read(self, key):
        body = self.objects.get(key)
        return body, p.sha(body) if body else None

    def put(self, key, body, etag=None):
        old, actual = self.read(key)
        if (etag and actual != etag) or (not etag and old is not None) or (self.race and key == 'current.json'):
            raise RuntimeError('Conditional write failed')
        self.objects[key] = body

    def verify_public(self, key, body):
        if key == self.failed_public or self.objects.get(key) != body:
            raise ValueError('Public verification failed')


class PublisherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = MemoryR2()
        self.version = '2026.09.19-registry.1'
        self.make_export(self.version)

    def make_export(self, version):
        core = b'exact-core-archive'
        catalog = {'releaseVersion': version, 'core': {'version': '0.2.0-core.15',
                   'artifact': 'vendor/core.tgz', 'artifactSha256': p.sha(core)}}
        files = {'catalog.json': p.encode(catalog), 'vendor/core.tgz': core, 'LICENSE': b'MIT'}
        for name, body in files.items():
            dest = self.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
        (self.root / 'SHA256SUMS').write_text(''.join(f'{p.sha(body)}  {name}\n' for name, body in files.items()))

    def publish(self, commit='a' * 40):
        result = p.publish(self.store, self.root, commit)
        return result['catalog'].replace('catalog.json', 'release.json')

    def test_publish_promote_second_release_and_rollback(self):
        first = self.publish()
        self.assertNotIn('current.json', self.store.objects)
        p.promote(self.store, first)
        first_current = self.store.objects['current.json']
        self.make_export('2026.09.19-registry.2')
        second = self.publish('b' * 40)
        p.promote(self.store, second)
        self.assertNotEqual(self.store.objects['current.json'], first_current)
        self.assertEqual(self.store.objects['history/' + p.sha(first_current) + '.json'], first_current)
        p.promote(self.store, first)
        self.assertEqual(self.store.objects['current.json'], first_current)
        p.promote(self.store, first)  # repeat is idempotent

    def test_republish_same_bytes_and_conflict(self):
        self.publish()
        self.publish()
        self.store.objects[next(key for key in self.store.objects if key.endswith('/LICENSE'))] = b'conflict'
        with self.assertRaisesRegex(ValueError, 'Immutable'):
            self.publish()

    def test_candidate_cannot_promote(self):
        self.make_export(self.version + '-candidate')
        descriptor = self.publish()
        with self.assertRaisesRegex(ValueError, 'Candidate'):
            p.promote(self.store, descriptor)
        self.assertNotIn('current.json', self.store.objects)

    def test_public_failure_does_not_move_current(self):
        first = self.publish()
        p.promote(self.store, first)
        before = self.store.objects['current.json']
        self.make_export('2026.09.19-registry.2')
        second = self.publish('b' * 40)
        self.store.failed_public = second.replace('release.json', 'vendor/core.tgz')
        with self.assertRaisesRegex(ValueError, 'Public'):
            p.promote(self.store, second)
        self.assertEqual(before, self.store.objects['current.json'])

    def test_manifest_corruption_missing_and_private_extra(self):
        (self.root / 'LICENSE').write_text('bad')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.publish()
        self.make_export(self.version)
        (self.root / '.env').write_text('private')
        with self.assertRaisesRegex(ValueError, 'Unlisted'):
            self.publish()
        (self.root / '.env').unlink()
        (self.root / 'LICENSE').unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.publish()

    def test_symlinks_rejected(self):
        (self.root / 'link').symlink_to(self.root / 'LICENSE')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            self.publish()

    def test_race_and_cross_origin_rejected(self):
        descriptor = self.publish()
        self.store.race = True
        with self.assertRaisesRegex(RuntimeError, 'Conditional'):
            p.promote(self.store, descriptor)
        self.assertNotIn('current.json', self.store.objects)
        value = json.loads(self.store.objects[descriptor])
        value['base'] = 'https://elsewhere.test'
        self.store.objects[descriptor] = p.encode(value)
        with self.assertRaisesRegex(ValueError, 'origin'):
            p.promote(self.store, descriptor)

    def test_incomplete_snapshot_never_gets_descriptor(self):
        prefix = f'releases/{self.version}/' + 'a' * 40
        self.store.failed_public = prefix + '/vendor/core.tgz'
        with self.assertRaisesRegex(ValueError, 'Public'):
            self.publish()
        self.assertNotIn(prefix + '/release.json', self.store.objects)
        self.assertNotIn('current.json', self.store.objects)

    def test_tampered_remote_asset_cannot_promote(self):
        descriptor = self.publish()
        self.store.objects[descriptor.replace('release.json', 'vendor/core.tgz')] = b'corrupt'
        with self.assertRaisesRegex(ValueError, 'checksum'):
            p.promote(self.store, descriptor)
        self.assertNotIn('current.json', self.store.objects)


if __name__ == '__main__':
    unittest.main()
