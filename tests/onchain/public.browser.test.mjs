import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.RETEMPO_PLAYWRIGHT_MODULE||'/home/deseti/.local/share/retempo/browser-test-tools/node_modules/playwright')
const base=process.env.RETEMPO_PREVIEW_URL||'http://127.0.0.1:4319'
const evidence=process.env.RETEMPO_BROWSER_EVIDENCE_DIR||'/home/deseti/.hermes/cache/scratch/retempo-wallet-browser'
const h=`0x${'11'.repeat(32)}`
// Explicit HTTP fixtures only. This suite does not mock or claim any transaction settlement.
const configuration={chainId:5042,mode:'disabled',configured:false,rpcUrl:'https://rpc.mainnet.arc.io',explorerUrl:'https://explorer.arc.io',usdc:'0x3600000000000000000000000000000000000000',usdcDecimals:6,manager:null,escrow:null,startBlock:null,reason:'Payments are disabled: no verified deployment is configured.'}
const checkout={id:'fixture-checkout',status:'open',expiresAt:'2099-01-01T00:00:00Z',merchantName:'HTTP fixture merchant',productName:'Workspace',planName:'Pro',description:'Explicit public capability fixture, not settlement evidence.',amount:'12345678',interval:'month',intervalSeconds:2592000,trialDays:0,escrowDays:0,planKey:h,merchant:'0x1111111111111111111111111111111111111111',payout:'0x1111111111111111111111111111111111111111',arbitrator:'0x0000000000000000000000000000000000000000',customerMayRefundUnvested:false,subscriptionId:'fixture-subscription',invoiceId:'fixture-invoice',configuration}
let browser
const results=[]
before(async()=>{await mkdir(evidence,{recursive:true});browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']})})
after(async()=>{await browser?.close();await writeFile(path.join(evidence,'results.json'),JSON.stringify(results,null,2))})
for(const width of [320,360,390,768,1440])test(`checkout disabled capability fits ${width}px and cannot pay`,async()=>{
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/api/**',route=>{const url=new URL(route.request().url());const body=url.pathname.includes('/public/')?checkout:url.pathname==='/api/chain/config'?configuration:{error:{code:'unauthenticated',message:'Sign in required'}};return route.fulfill({status:url.pathname==='/api/auth/me'?401:200,json:body})})
 try{await page.goto(`${base}/pay/explicit-fixture-token`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Workspace Pro'}).waitFor();await page.getByRole('button',{name:'Approve exact amount & subscribe'}).waitFor();assert.equal(await page.getByRole('button',{name:'Approve exact amount & subscribe'}).isDisabled(),true);assert.equal(await page.getByText('12.345678',{exact:false}).count()>0,true);const dims=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(dims.document<=dims.viewport,JSON.stringify(dims));assert.equal(await page.getByText('Demo data.',{exact:false}).count(),0);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(evidence,`disabled-${width}.png`),fullPage:true});results.push({case:'disabled',width,...dims,errors})}finally{await page.close()}
})
test('invalid invoice capability shows a server error instead of private/demo invoice data',async()=>{
 const page=await browser.newPage()
 await page.route('**/api/**',route=>route.fulfill({status:404,json:{error:{code:'not_found',message:'Capability expired or revoked'}}}))
 try{await page.goto(`${base}/invoice/invalid-capability`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Payment link unavailable'}).waitFor();assert.equal(await page.getByRole('button',{name:'Retry loading link'}).count(),1);assert.equal(await page.getByRole('button',{name:/approve.*subscribe/i}).count(),0);results.push({case:'invalid-invoice',passed:true})}finally{await page.close()}
})
test('portal unconfigured state is honest and never renders demo customers',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}})
 await page.route('**/api/**',route=>route.fulfill({status:route.request().url().endsWith('/auth/me')?401:200,json:route.request().url().endsWith('/chain/config')?configuration:{error:{code:'unauthenticated',message:'Sign in required'}}}))
 try{await page.goto(`${base}/portal`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Deployment disabled'}).waitFor();assert.equal(await page.getByText('Demo data.',{exact:false}).count(),0);results.push({case:'disabled-portal',passed:true})}finally{await page.close()}
})
