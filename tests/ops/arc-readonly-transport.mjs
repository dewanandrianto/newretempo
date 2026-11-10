// Opt-in read-only official RPC probe using the actual private Rpc in local workerd.
// No transactions, credentials, account APIs or deployment are involved.
import { Miniflare, convertV4MiniflareOptions } from '../../node_modules/miniflare/dist/src/index.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'retempo-readonly-'));
const output = join(root, 'docs/phase-5-evidence/workerd-official-rpc.json');
let mf;
try {
  const input = join(temporary, 'probe.ts'), bundle = join(temporary, 'probe.js');
  await writeFile(input, `import {Rpc, USDC} from ${JSON.stringify(join(root, 'chain-worker/src/service.ts'))};
export default {async fetch() {
 const rpc=new Rpc('https://rpc.mainnet.arc.io',fetch);
 const observations=[];
 for(const [method,params] of [['eth_chainId',[]],['eth_blockNumber',[]],['eth_getCode',[USDC,'latest']],['eth_call',[{to:USDC,data:'0x313ce567'},'latest']]]) {
  try {const result=await rpc.call(method,params);observations.push({method,ok:true,result:method==='eth_getCode'?{nonemptyCode:result!=='0x',codeBytes:(result.length-2)/2}:result});}
  catch(error) {observations.push({method,ok:false,error:error.message});}
 }
 return Response.json({scope:'Local workerd actual production Rpc read-only transport; no deployment or transactions; not provider CPU proof',observations});
}};`);
  const build = spawnSync(join(homedir(), '.local/share/retempo/toolchains/bun-v1.3.14/bun'), ['--no-env-file', 'build', input, '--target=browser', '--format=esm', '--outfile=' + bundle], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw Error(build.stderr || build.stdout);
  mf = new Miniflare(convertV4MiniflareOptions({ rootPath: temporary, workers: [{ name: 'read-only-probe', modules: true, scriptPath: bundle, compatibilityDate: '2026-11-08' }] }));
  const response = await mf.dispatchFetch('http://localhost/probe');
  const report = await response.json();
  report.passed = response.ok && report.observations.length === 4 && report.observations.every(item => item.ok);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(await readFile(output, 'utf8'));
  if (!report.passed) process.exitCode = 1;
} finally {
  await mf?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
