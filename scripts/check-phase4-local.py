#!/usr/bin/env python3
"""Run the local Phase 4 acceptance matrix without deployment, accounts or remote writes."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('RETEMPO_EVIDENCE_DIR', str(ROOT / 'docs/phase-4-evidence'))).resolve()
BUN = str(Path.home() / '.local/share/retempo/toolchains/bun-v1.3.14/bun')
NODE = 'node'
OUT.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, WRANGLER_SEND_METRICS='false', CI='1', RETEMPO_EVIDENCE_DIR=str(OUT))
checks = [
    ('typecheck', [BUN, '--no-env-file', 'run', 'typecheck'], 120),
    ('indexer-typecheck', [NODE, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'chain-worker'], 120),
    ('lint', [BUN, '--no-env-file', 'run', 'lint'], 120),
    ('script-tests', [BUN, '--no-env-file', 'test', 'scripts'], 120),
    ('public-worker-tests', [NODE, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'worker/vitest.config.ts'], 360),
    ('private-worker-tests', [NODE, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'chain-worker/vitest.config.ts'], 120),
    ('wallet-tests', [NODE, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/onchain/vitest.config.ts'], 120),
    ('production-build', [BUN, '--no-env-file', 'run', 'build'], 180),
    ('signed-sdk', [BUN, '--no-env-file', 'test', 'tests/contracts/phase-4-sdk.integration.test.mjs'], 120),
    ('signed-browser-workers', [NODE, '--test', 'tests/browser/signed-worker-integration.test.mjs'], 240),
]
summary = {'scope': 'Local Phase 4 acceptance only; no deployment or remote chain writes', 'startedAt': datetime.now(timezone.utc).isoformat(), 'passed': False, 'checks': []}
ansi = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
for name, command, timeout in checks:
    started = time.monotonic()
    print(f'Running {name}', flush=True)
    check_env = dict(env)
    if name == 'signed-browser-workers':
        check_env['RETEMPO_BROWSER'] = '1'
    try:
        result = subprocess.run(command, cwd=ROOT, env=check_env, capture_output=True, text=True, timeout=timeout)
        output = ansi.sub('', result.stdout + result.stderr)
        code = result.returncode
    except subprocess.TimeoutExpired as error:
        output = f'TIMEOUT after {timeout}s; this check is not passing.\n'
        for stream in [error.stdout, error.stderr]:
            if stream:
                output += stream.decode(errors='replace') if isinstance(stream, bytes) else stream
        code = 124
    log = OUT / f'final-{name}.log'
    log.write_text(output)
    count = re.search(r'Tests\s+(\d+)\s+passed', output) or re.search(r'\b(\d+)\s+pass\b', output) or re.search(r'ℹ pass (\d+)', output)
    row = {'name': name, 'command': command, 'exitCode': code, 'seconds': round(time.monotonic() - started, 2), 'log': str(log.relative_to(ROOT))}
    if count:
        row['passingTests'] = int(count.group(1))
    summary['checks'].append(row)
    print(json.dumps(row), flush=True)
    (OUT / 'final-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
    if code:
        print(output[-12000:], flush=True)
        sys.exit(code)
for filename in ['signed-worker-integration.json', 'signed-sdk-integration.json']:
    report = json.loads((OUT / filename).read_text())
    assert report['passed'] is True and report['nodeStopped'] is True, filename
    summary[filename] = report
files = sorted(path for directory in ['src', 'shared', 'worker/src', 'worker/migrations', 'chain-worker/src', 'chain-worker/migrations', 'contracts'] for path in (ROOT / directory).rglob('*') if path.is_file() and 'phase-3-build' not in path.parts and 'abi' not in path.parts and path.suffix in ['.ts', '.tsx', '.sol', '.sql'])
summary['sourceSha256'] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
summary['finishedAt'] = datetime.now(timezone.utc).isoformat()
summary['passed'] = True
(OUT / 'final-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'passed': True, 'checks': len(summary['checks']), 'testCounts': {row['name']: row['passingTests'] for row in summary['checks'] if 'passingTests' in row}, 'sourceFiles': len(files)}), flush=True)
