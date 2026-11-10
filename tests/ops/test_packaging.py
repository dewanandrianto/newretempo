"""Real isolated Wrangler dry-runs; synthetic IDs are never deployed resources."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import test_production_config as fixtures

ROOT = Path(__file__).resolve().parents[2]


class PackagingTests(unittest.TestCase):
    def test_public_and_private_configs_compile_without_credentials_or_uploads(self):
        configs = fixtures.module.build_configs(fixtures.ProductionConfigTests().fixture())
        scratch = os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch'))
        evidence = Path(os.environ.get('RETEMPO_EVIDENCE_DIR', ROOT / 'docs/phase-5-evidence')).resolve()
        history = (ROOT / 'docs/phase-4-evidence').resolve()
        self.assertFalse(evidence == history or evidence.is_relative_to(history), 'Historical evidence is not an output target')
        evidence.mkdir(parents=True, exist_ok=True)
        results = []
        with tempfile.TemporaryDirectory(dir=scratch, prefix='retempo-packaging-unit-') as temporary:
            folder = Path(temporary)
            home = folder / 'home'
            home.mkdir()
            env = {key: value for key, value in os.environ.items() if key in ['PATH', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']}
            env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'config'), CI='1', WRANGLER_SEND_METRICS='false')
            for name, config in configs.items():
                with self.subTest(worker=name):
                    source = folder / (name + '.json')
                    source.write_text(json.dumps(config))
                    source.chmod(0o600)
                    destination = folder / (name + '-bundle')
                    command = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--config', str(source), '--outdir', str(destination)]
                    result = subprocess.run(command, cwd=folder, env=env, capture_output=True, text=True, timeout=90)
                    log = evidence / ('packaging-test-' + name + '.log')
                    log.write_text(result.stdout + result.stderr)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    emitted = [file for file in destination.rglob('*') if file.is_file()]
                    self.assertTrue(any(file.suffix == '.js' for file in emitted), 'Dry-run must emit an actual Worker bundle')
                    results.append({'worker': name, 'exitCode': result.returncode, 'dryRun': True, 'resourceIdsAreSynthetic': True, 'productionResourcesVerified': False, 'deploymentAuthorized': False, 'log': str(log.relative_to(ROOT)) if log.is_relative_to(ROOT) else str(log), 'bundleSha256': {str(file.relative_to(destination)): hashlib.sha256(file.read_bytes()).hexdigest() for file in emitted}})
        (evidence / 'packaging-test-results.json').write_text(json.dumps({'scope': 'Actual credential-isolated local Wrangler packaging with synthetic fixtures; no installation, deployment or resource verification', 'checks': results}, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main()
