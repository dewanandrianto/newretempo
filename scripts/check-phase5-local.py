#!/usr/bin/env python3
"""Phase 5 local checks with separate evidence and preserved historical Phase 4 artifacts."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('RETEMPO_EVIDENCE_DIR', ROOT / 'docs/phase-5-evidence'))
BASELINE = ROOT / 'docs/phase-4-evidence'


def fingerprints(directory):
    return {str(file.relative_to(directory)): hashlib.sha256(file.read_bytes()).hexdigest() for file in directory.rglob('*') if file.is_file()}


def verification_inputs():
    directories = ['src', 'shared', 'worker/src', 'worker/tests', 'worker/migrations', 'chain-worker/src', 'chain-worker/tests', 'chain-worker/migrations', 'backend/src', 'tests', 'scripts', 'ops', 'contracts/abi']
    extensions = {'.ts', '.tsx', '.sol', '.sql', '.py', '.mjs', '.json', '.jsonc'}
    files = {file for directory in directories for file in (ROOT / directory).rglob('*') if file.is_file() and file.suffix in extensions and not any(part.startswith('.') for part in file.relative_to(ROOT).parts)}
    files.update((ROOT / 'contracts').rglob('*.sol'))
    for name in ['package.json', 'bun.lock', 'vite.config.ts', 'wrangler.jsonc', 'chain-worker/wrangler.jsonc', 'worker/vitest.config.ts', 'chain-worker/vitest.config.ts', 'tsconfig.json', 'worker/tsconfig.json', 'chain-worker/tsconfig.json', 'backend/tsconfig.json', 'tests/onchain/tsconfig.json', '.bun-version', '.foundry-version', '.gitignore', 'public/_headers']:
        if (ROOT / name).is_file():
            files.add(ROOT / name)
    return {str(file.relative_to(ROOT)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(files) if file.is_file()}


def main():
    global OUT
    OUT = OUT.resolve()
    if OUT == BASELINE.resolve() or OUT.is_relative_to(BASELINE.resolve()):
        print('ERROR: refusing to write Phase 5 results into historical Phase 4 evidence', file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    report_path = OUT / 'final-checks.json'
    # Invalidate before any subprocess, including early failures and spawn errors.
    report_path.write_text(json.dumps({'passed': False, 'checks': [], 'failure': 'Verification in progress; no current child verdict'}) + '\n')
    try:
        code = run_checks()
    except subprocess.TimeoutExpired as error:
        code, failure = 124, f'Verification timed out: {error.cmd}'
    except Exception as error:
        code, failure = 1, f'Verification failed: {type(error).__name__}: {error}'
    else:
        failure = f'Verification exited unsuccessfully ({code})'
    if code:
        try:
            report = json.loads(report_path.read_text())
            if not isinstance(report, dict):
                report = {}
        except (OSError, ValueError):
            report = {}
        report.update(passed=False, failure=failure, productionDeploymentAuthorized=False)
        report_path.write_text(json.dumps(report, indent=2) + '\n')
    return code


def run_checks():
    before = fingerprints(BASELINE)
    inputs_before = verification_inputs()
    env = dict(os.environ, RETEMPO_EVIDENCE_DIR=str(OUT), RETEMPO_COLD_RECOVERY='1', WRANGLER_SEND_METRICS='false', CI='1')
    ops = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/ops', '-v'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    (OUT / 'final-ops-tests.log').write_text(ops.stdout + ops.stderr)
    if ops.returncode:
        print(ops.stdout + ops.stderr)
        return ops.returncode
    result = subprocess.run([sys.executable, 'scripts/check-phase4-local.py'], cwd=ROOT, env=env, timeout=1800)
    if before != fingerprints(BASELINE):
        print('ERROR: historical Phase 4 evidence changed', file=sys.stderr)
        return 1
    if result.returncode:
        return result.returncode
    report_path = OUT / 'final-checks.json'
    report = json.loads(report_path.read_text())
    if not isinstance(report, dict) or report.get('passed') is not True or not isinstance(report.get('checks'), list):
        raise ValueError('Current child report is absent, malformed or not passing')
    if not report.get('signed-worker-integration.json', {}).get('coldRecovery', {}).get('canonicalCursorPreserved'):
        report['passed'] = False
        report['scope'] = 'Phase 5 local checks incomplete; no deployment authorized'
        report['failure'] = 'Cold recovery proof is absent'
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        print('ERROR: cold recovery proof is absent', file=sys.stderr)
        return 1
    report['scope'] = 'Phase 5 local production-readiness regression; no deployment or remote chain writes'
    command = ['node', '--test', 'tests/onchain/frontend-build.test.mjs', 'tests/onchain/frontend-routes.browser.test.mjs']
    try:
        frontend = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired as error:
        def text(stream):
            return stream.decode(errors='replace') if isinstance(stream, bytes) else stream or ''
        frontend = subprocess.CompletedProcess(command, 124, text(error.stdout), 'TIMEOUT after 90s; this check is not passing.\n' + text(error.stderr))
    (OUT / 'final-frontend-routes.log').write_text(frontend.stdout + frontend.stderr)
    report['checks'].append({'name': 'frontend-build-routes', 'command': command, 'exitCode': frontend.returncode, 'log': str((OUT / 'final-frontend-routes.log').relative_to(ROOT))})
    if frontend.returncode or before != fingerprints(BASELINE):
        report['passed'] = False
        report['failure'] = 'Frontend regression failed or historical evidence changed'
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        return frontend.returncode or 1
    inputs_after = verification_inputs()
    drift = sorted(name for name in inputs_before.keys() | inputs_after.keys() if inputs_before.get(name) != inputs_after.get(name))
    if drift:
        report.update(passed=False, failure='Verification inputs changed during execution', sourceDrift=drift)
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        return 1
    report['verificationInputsSha256'] = inputs_before
    report['sourceDrift'] = []
    report['phase4EvidencePreserved'] = True
    report['opsTestExitCode'] = ops.returncode
    report['productionDeploymentAuthorized'] = False
    report['productionResourcesVerified'] = False
    additional = sorted([* (ROOT / 'ops').rglob('*.json'), * (ROOT / 'scripts').glob('*phase5*.py'), ROOT / 'scripts/production_config.py'])
    report['preparationSourceSha256'] = {str(file.relative_to(ROOT)): hashlib.sha256(file.read_bytes()).hexdigest() for file in additional if file.is_file()}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': True, 'phase4EvidencePreserved': True, 'coldRecoveryVerified': True, 'productionDeploymentAuthorized': False}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
