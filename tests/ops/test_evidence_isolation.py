"""Run real local SDK acceptance while preserving the historical Phase 4 evidence."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class EvidenceIsolationTests(unittest.TestCase):
    def test_new_acceptance_can_write_separate_evidence_without_overwriting_phase4(self):
        # Fail before executing an old fixed-output runner: the baseline is not a scratch file.
        sources = ['scripts/check-phase4-local.py', 'tests/contracts/phase-4-sdk.integration.test.mjs', 'tests/browser/signed-worker-integration.test.mjs']
        for filename in sources:
            self.assertIn('RETEMPO_EVIDENCE_DIR', (ROOT / filename).read_text(), filename)
        baseline = ROOT / 'docs/phase-4-evidence/signed-sdk-integration.json'
        before = hashlib.sha256(baseline.read_bytes()).hexdigest()
        scratch = os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch'))
        with tempfile.TemporaryDirectory(dir=scratch, prefix='retempo-evidence-') as directory:
            env = dict(os.environ, RETEMPO_EVIDENCE_DIR=directory)
            bun = str(Path.home() / '.local/share/retempo/toolchains/bun-v1.3.14/bun')
            result = subprocess.run([bun, '--no-env-file', 'test', 'tests/contracts/phase-4-sdk.integration.test.mjs'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((Path(directory) / 'signed-sdk-integration.json').read_text())
            self.assertTrue(report['passed'])
            self.assertTrue(report['nodeStopped'])
        self.assertEqual(hashlib.sha256(baseline.read_bytes()).hexdigest(), before)


if __name__ == '__main__':
    unittest.main()
