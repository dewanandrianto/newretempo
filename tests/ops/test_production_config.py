"""Local shape-validation fixtures, not real Cloudflare resources or deployments."""
import importlib.util
from pathlib import Path
import unittest
from copy import deepcopy
import json
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('production_config', ROOT / 'scripts/production_config.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProductionConfigTests(unittest.TestCase):
    def fixture(self):
        return {'schemaVersion': 1, 'domain': 'retempo.xyz', 'cloudflare': {'accountId': 'a' * 32, 'publicDatabaseId': '11111111-1111-4111-8111-111111111111', 'chainDatabaseId': '22222222-2222-4222-8222-222222222222', 'publicWorkerName': 'retempo', 'chainWorkerName': 'retempo-chain'}, 'arc': {'chainId': 5042, 'rpcUrl': 'https://rpc.mainnet.arc.io', 'explorerUrl': 'https://explorer.arc.io', 'usdc': '0x3600000000000000000000000000000000000000', 'manager': '0x1111111111111111111111111111111111111111', 'escrow': '0x2222222222222222222222222222222222222222', 'startBlock': '123', 'genesisHash': '0x' + 'a' * 64, 'managerCodeHash': '0x' + 'b' * 64, 'escrowCodeHash': '0x' + 'c' * 64}}

    def test_incomplete_owner_configuration_is_never_packaged(self):
        with self.assertRaises(module.ConfigurationError) as caught:
            module.build_configs({'schemaVersion': 1, 'domain': 'retempo.xyz', 'cloudflare': {}, 'arc': {}})
        self.assertIn('accountId', str(caught.exception))
        self.assertIn('manager', str(caught.exception))

    def test_generated_configs_separate_authority_and_require_real_runtime_secrets(self):
        configs = module.build_configs(self.fixture())
        public, private = configs['public'], configs['private']
        self.assertEqual(public['services'], [{'binding': 'CHAIN', 'service': 'retempo-chain'}])
        self.assertEqual([x['binding'] for x in public['d1_databases']], ['DB'])
        self.assertEqual([x['binding'] for x in private['d1_databases']], ['CHAIN_DB'])
        self.assertFalse(public['workers_dev'])
        self.assertFalse(private['preview_urls'])
        self.assertEqual(private['routes'], [])
        self.assertEqual(public['secrets']['required'], ['SESSION_SECRET'])
        self.assertNotIn('SESSION_SECRET', public['vars'])
        self.assertEqual(public['vars']['COOKIE_SECURE'], 'true')
        self.assertEqual(private['vars']['ARC_EXPECTED_MANAGER_CODE_HASH'], self.fixture()['arc']['managerCodeHash'])

    def test_unsafe_or_malformed_identifiers_are_rejected_not_repaired(self):
        cases = [('domain', None, 'http://localhost'), ('cloudflare', 'accountId', 'not-an-account'), ('cloudflare', 'publicDatabaseId', 'REQUIRED'), ('cloudflare', 'chainDatabaseId', self.fixture()['cloudflare']['publicDatabaseId']), ('cloudflare', 'chainWorkerName', 'retempo'), ('arc', 'chainId', 5042002), ('arc', 'rpcUrl', 'http://localhost:8545'), ('arc', 'manager', '0x123'), ('arc', 'escrow', self.fixture()['arc']['manager']), ('arc', 'startBlock', '01'), ('arc', 'managerCodeHash', '0x00')]
        for section, field, value in cases:
            with self.subTest(section=section, field=field):
                data = deepcopy(self.fixture())
                if field is None:
                    data[section] = value
                else:
                    data[section][field] = value
                with self.assertRaises(module.ConfigurationError):
                    module.build_configs(data)

    def test_secret_values_are_not_serialized_or_echoed(self):
        data = self.fixture()
        data['cloudflare']['apiToken'] = 'EXPLICIT-UNIT-FIXTURE-NOT-A-REAL-TOKEN'
        with self.assertRaises(module.ConfigurationError) as caught:
            module.build_configs(data)
        self.assertNotIn(data['cloudflare']['apiToken'], str(caught.exception))

    def test_cli_emits_only_local_preparation_and_no_deployment_approval(self):
        scratch = os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch'))
        with tempfile.TemporaryDirectory(dir=scratch, prefix='retempo-ops-') as directory:
            source = Path(directory) / 'config.json'
            source.write_text(json.dumps(self.fixture()))
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/production_config.py'), '--input', str(source)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            output = json.loads(result.stdout)
            self.assertTrue(output['configurationValid'])
            self.assertFalse(output['productionResourcesVerified'])
            self.assertFalse(output['deploymentAuthorized'])
            source.write_text('{}')
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/production_config.py'), '--input', str(source)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)

    def test_cli_writes_only_validated_configs_in_ignored_project_namespace(self):
        base = ROOT / '.wrangler/production'
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base, prefix='unit-fixture-') as directory:
            source = Path(directory) / 'input.json'
            data = self.fixture()
            data['cloudflare']['accountId'] = 'AB' * 16
            source.write_text(json.dumps(data))
            output = Path(directory) / 'generated'
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/production_config.py'), '--input', str(source), '--write-dir', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            public = json.loads((output / 'public.json').read_text())
            private = json.loads((output / 'private.json').read_text())
            self.assertEqual(public['account_id'], data['cloudflare']['accountId'])
            self.assertEqual(private['routes'], [])
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/production_config.py'), '--input', str(source), '--write-dir', str(ROOT / 'ops/unapproved-output')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse((ROOT / 'ops/unapproved-output').exists())


if __name__ == '__main__':
    unittest.main()
