"""Unit fixtures exercise the runner's verdict handling, not production execution."""
import importlib.util
import json
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('phase5_runner', ROOT / 'scripts/check-phase5-local.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Phase5RunnerTests(unittest.TestCase):
    def test_historical_evidence_destination_is_rejected_before_writes(self):
        scratch = os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch'))
        with tempfile.TemporaryDirectory(dir=scratch, prefix='runner-isolation-unit-') as temporary:
            root = Path(temporary)
            baseline = root / 'docs/phase-4-evidence'
            for out in [baseline, baseline / 'nested']:
                with self.subTest(destination=str(out)):
                    out.mkdir(parents=True, exist_ok=True)
                    (out / 'final-checks.json').write_text('{"passed":true,"historical":true}')
                    before = runner.fingerprints(baseline)
                    success = subprocess.CompletedProcess([], 0, stdout='', stderr='')
                    with patch.object(runner, 'ROOT', root), patch.object(runner, 'OUT', out), patch.object(runner, 'BASELINE', baseline), patch.object(runner.subprocess, 'run', return_value=success) as calls:
                        self.assertNotEqual(runner.main(), 0)
                    self.assertEqual(runner.fingerprints(baseline), before)
                    calls.assert_not_called()

    def exercise(self, scenario):
        scratch = os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch'))
        with tempfile.TemporaryDirectory(dir=scratch, prefix='runner-unit-') as temporary:
            root = Path(temporary)
            out = root / 'docs/phase-5-evidence'
            baseline = root / 'docs/phase-4-evidence'
            out.mkdir(parents=True)
            baseline.mkdir(parents=True)
            (baseline / 'historic.json').write_text('{"historical":true}')
            report_path = out / 'final-checks.json'
            source = root / 'src/fixture.ts'
            source.parent.mkdir()
            source.write_text('export const revision = 1;\n')
            report_path.write_text(json.dumps({'passed': True, 'checks': [], 'stale': True}))
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                stage = len(commands)
                if scenario == 'ops-failure' and stage == 1:
                    return subprocess.CompletedProcess(command, 7, stdout='intentional ops failure', stderr='')
                if (scenario == 'ops-timeout' and stage == 1) or (scenario == 'child-timeout' and stage == 2) or (scenario == 'frontend-timeout' and stage == 3):
                    raise subprocess.TimeoutExpired(command, 90)
                if scenario == 'exception' and stage == 1:
                    raise OSError('intentional spawn failure')
                if stage == 2:
                    if scenario == 'missing':
                        report_path.unlink(missing_ok=True)
                    elif scenario == 'malformed':
                        report_path.write_text('{bad json')
                    elif scenario == 'wrong-shape':
                        report_path.write_text('[]')
                    elif scenario != 'no-fresh-report':
                        report = {'passed': scenario != 'child-verdict-false', 'checks': []}
                        if scenario != 'missing-cold':
                            report['signed-worker-integration.json'] = {'coldRecovery': {'canonicalCursorPreserved': True}}
                        report_path.write_text(json.dumps(report))
                    if scenario == 'child-failure':
                        return subprocess.CompletedProcess(command, 8)
                if scenario == 'source-mutation' and stage == 3:
                    source.write_text('export const revision = 2;\n')
                if scenario == 'frontend-failure' and stage == 3:
                    return subprocess.CompletedProcess(command, 9, stdout='', stderr='intentional frontend failure')
                return subprocess.CompletedProcess(command, 0, stdout='', stderr='')

            with patch.object(runner, 'ROOT', root), patch.object(runner, 'OUT', out), patch.object(runner, 'BASELINE', baseline), patch.object(runner.subprocess, 'run', side_effect=run):
                try:
                    code = runner.main()
                except Exception:
                    code = 1
            persisted = json.loads(report_path.read_text()) if report_path.exists() else None
            return code, persisted, commands

    def test_phase5_runner_includes_real_bundle_and_route_regressions(self):
        code, report, commands = self.exercise('success')
        self.assertEqual(code, 0)
        self.assertTrue(report['passed'])
        self.assertNotIn('stale', report)
        self.assertTrue(any('tests/onchain/frontend-build.test.mjs' in command and 'tests/onchain/frontend-routes.browser.test.mjs' in command for command in commands))

    def test_unsuccessful_paths_replace_stale_success(self):
        for scenario in ['ops-failure', 'child-failure', 'ops-timeout', 'child-timeout', 'exception', 'missing', 'malformed', 'wrong-shape', 'no-fresh-report', 'child-verdict-false', 'frontend-failure', 'frontend-timeout', 'missing-cold']:
            with self.subTest(scenario=scenario):
                code, report, _ = self.exercise(scenario)
                self.assertNotEqual(code, 0)
                self.assertIsNotNone(report)
                self.assertIs(report['passed'], False)
                self.assertIn('failure', report)

    def test_source_changes_during_checks_invalidate_the_passing_child(self):
        code, report, _ = self.exercise('source-mutation')
        self.assertNotEqual(code, 0)
        self.assertFalse(report['passed'])
        self.assertEqual(report['sourceDrift'], ['src/fixture.ts'])

    def test_frontend_timeout_cannot_leave_a_passing_final_report(self):
        code, report, _ = self.exercise('frontend-timeout')
        self.assertEqual(code, 124)
        self.assertFalse(report['passed'])

    def test_missing_cold_proof_cannot_leave_a_passing_final_report(self):
        code, report, _ = self.exercise('missing-cold')
        self.assertEqual(code, 1)
        self.assertFalse(report['passed'])


if __name__ == '__main__':
    unittest.main()
