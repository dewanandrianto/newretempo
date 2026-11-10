from pathlib import Path
import concurrent.futures, subprocess, os, time, json, datetime
ROOT=Path('/home/deseti/projects/retempo')
OUT=ROOT/'docs/phase-5-evidence/session-fence-final-review-probes'
env=dict(os.environ, RETEMPO_EVIDENCE_DIR=str(OUT), WRANGLER_SEND_METRICS='false', CI='1')
env.pop('NODE_OPTIONS',None)
checks=[
 ('auth',['node','node_modules/vitest/vitest.mjs','run','--config','worker/vitest.config.ts','worker/tests/session-fence.test.ts','worker/tests/recovery-security.test.ts','worker/tests/membership-security.test.ts','worker/tests/auth.test.ts','worker/tests/auth-account.test.ts','--disableConsoleIntercept','--reporter=default','--reporter=json',f'--outputFile={OUT}/auth-tests.json'],360),
 ('independent-current-api',['node','node_modules/vitest/vitest.mjs','run','--config',str(OUT/'vitest.config.ts'),'--disableConsoleIntercept','--reporter=default','--reporter=json',f'--outputFile={OUT}/independent-tests.json'],180),
 ('indexer',['node','node_modules/vitest/vitest.mjs','run','--config','chain-worker/vitest.config.ts','chain-worker/tests/indexer-review.test.ts','chain-worker/tests/indexer-overflow.test.ts','chain-worker/tests/indexer-ancestor-budget.test.ts','--disableConsoleIntercept'],180),
 ('ops',['python3','-m','unittest','discover','-s','tests/ops','-v'],180),
 ('worker-types',['node','node_modules/typescript/bin/tsc','--noEmit','-p','worker'],120),
 ('packaged-spa',['node','--test','tests/onchain/frontend-build.test.mjs'],90)
]
def run(item):
 name,cmd,timeout=item; start=time.monotonic()
 with (OUT/f'{name}.log').open('w') as log:
  try: code=subprocess.run(cmd,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=timeout).returncode
  except subprocess.TimeoutExpired: code=124; log.write('\nREVIEW TIMEOUT\n')
 result=dict(name=name,command=cmd,exitCode=code,seconds=round(time.monotonic()-start,3),log=str((OUT/f'{name}.log').relative_to(ROOT)))
 (OUT/f'{name}-run.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result),flush=True)
 return result
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(run,checks))
(OUT/'checks.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(int(any(r['exitCode']!=0 for r in results)))
