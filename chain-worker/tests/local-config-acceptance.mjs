// Real fresh non-forked loopback Arc + workerd regression; no production writes.
import { startLocalArc } from '../../tests/helpers/arc-local.mjs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
const arc=await startLocalArc();
try {
 const bindings={APP_ENV:'test',ARC_RPC_URL:arc.url,ARC_MANAGER_ADDRESS:arc.manager,ARC_ESCROW_ADDRESS:arc.escrow,ARC_START_BLOCK:arc.configuration.startBlock};
 const scriptPath=arc.directory+'/config-worker.js';
 await build({entryPoints:['chain-worker/tests/config-worker.ts'],outfile:scriptPath,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({rootPath:arc.directory,workers:[{name:'diagnostic',modules:true,scriptPath,compatibilityDate:'2026-11-08',bindings}]}));
 try{const response=await mf.dispatchFetch('https://diagnostic/v1/config');const body=await response.text();console.log(body);assert.equal(response.status,200,body)}finally{await mf.dispose()}
}finally{await arc.stop()}
