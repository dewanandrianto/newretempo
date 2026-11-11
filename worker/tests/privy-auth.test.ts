import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, it, expect } from 'vitest'
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { establishSession, resolveAuth } from '../src/auth/sessions'
import { registerAuthRoutes } from '../src/auth/routes'
import { registerCatalogRoutes } from '../src/catalog/routes'
import { validateBindings } from '../src/config'
import { HttpError } from '../src/errors'
import type { WorkerBindings, WorkerContext } from '../src/types'

const db=(env as unknown as WorkerBindings).DB
const APP_ID='cmwc2a0lq013r0gic5qink0rr'
const keysPromise=generateKeyPair('ES256').then(async keys=>({ ...keys, publicSpki: await exportSPKI(keys.publicKey) }))
const testBindings=async (extra:Partial<WorkerBindings>={}) => ({
  ...env,
  APP_ENV:'test',
  EMAIL_MODE:'test',
  SESSION_SECRET:'privy-auth-test-secret-minimum-thirty-two-characters',
  APP_ORIGINS:'https://app.test',
  SIWE_DOMAIN:'app.test',
  SIWE_URI:'https://app.test',
  SIWE_CHAIN_ID:'5042002',
  PRIVY_APP_ID:APP_ID,
  PRIVY_APP_SECRET:'synthetic-test-app-secret-never-used-for-network',
  PRIVY_AUTH_ENABLED:'true',
  PRIVY_TEST_VERIFICATION_KEY:(await keysPromise).publicSpki,
  ...extra,
}) as WorkerBindings
function app() {
  const a=new Hono<WorkerContext>()
  a.use('*',async(c,next)=>{c.set('ip','192.0.2.21');c.set('requestId',crypto.randomUUID());c.set('auth',await resolveAuth(c));await next()})
  a.onError((e,c)=>e instanceof HttpError?c.json({error:{code:e.code,message:e.message}},e.status as 400):c.json({error:{message:'internal'}},500))
  registerAuthRoutes(a)
  registerCatalogRoutes(a)
  // Test-only helper to issue a real server session for an existing fixture user.
  a.post('/test/password-session/:userId',async c=>{
    await establishSession(c,{method:'password',userId:c.req.param('userId'),passwordHash:'synthetic-test-password-hash'})
    return c.json({ok:true})
  })
  return a
}
async function request(path:string,options:{method?:string;accessToken?:string;cookie?:string;extra?:Partial<WorkerBindings>}={}) {
  const headers:Record<string,string>={...(options.accessToken?{authorization:`Bearer ${options.accessToken}`}:{}) ,...(options.cookie?{cookie:options.cookie}:{})}
  return app().request(`https://app.test/api/auth/${path}`,{method:options.method??'GET',headers},await testBindings(options.extra))
}
const cookieOf=(response:Response)=>response.headers.get('set-cookie')!.split(';')[0]
async function signedToken(options:{sub?:string;iss?:string;aud?:string|string[];sid?:string;exp?:number;iat?:number;extra?:Record<string,unknown>}={}) {
  const keys=await keysPromise,now=Math.floor(Date.now()/1000)
  return new SignJWT({sid:options.sid??'synthetic-session-id',...(options.extra??{})})
    .setProtectedHeader({alg:'ES256',typ:'JWT',kid:'privy-test-key'})
    .setIssuer(options.iss??'privy.io')
    .setAudience(options.aud??APP_ID)
    .setSubject(options.sub??`did:privy:test-${crypto.randomUUID()}`)
    .setIssuedAt(options.iat??now)
    .setExpirationTime(options.exp??now+300)
    .sign(keys.privateKey)
}
async function insertUser(email='legacy@example.test') {
  const id=crypto.randomUUID()
  await db.prepare("INSERT INTO users(id,email,password_hash,display_name) VALUES (?,?,?,'Legacy')").bind(id,email,'synthetic-test-password-hash').run()
  return id
}

 describe('Privy Testnet authentication',()=>{
  it('fails closed by default and exposes only public runtime configuration',async()=>{
    const response=await request('config',{extra:{PRIVY_AUTH_ENABLED:'false'}})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({enabled:false,appId:null})
    const login=await request('privy/login',{method:'POST',accessToken:await signedToken(),extra:{PRIVY_AUTH_ENABLED:'false'}})
    expect(login.status).toBe(503)
  })

  it('creates one internal user per signed Privy DID and issues a Privy-labelled session',async()=>{
    const did=`did:privy:test-${crypto.randomUUID()}`
    const token=await signedToken({sub:did,aud:[APP_ID,'another-valid-audience'],extra:{email:'existing@example.test'}})
    const first=await request('privy/login',{method:'POST',accessToken:token})
    expect(first.status).toBe(200)
    const firstBody=await first.json() as {user:{id:string;email:string|null;displayName:string};session:{method:string}}
    expect(firstBody).toMatchObject({user:{email:null,displayName:''},session:{method:'privy'}})
    const sessionRow=await db.prepare('SELECT auth_method,auth_provider FROM sessions WHERE user_id=?').bind(firstBody.user.id).first<{auth_method:string;auth_provider:string|null}>()
    expect(sessionRow).toEqual({auth_method:'password',auth_provider:'privy'})
    expect(await db.prepare('SELECT count(*) AS n FROM privy_identities WHERE privy_user_id=? AND user_id=?').bind(did,firstBody.user.id).first('n')).toBe(1)

    const second=await request('privy/login',{method:'POST',accessToken:token})
    const secondBody=await second.json() as {user:{id:string}}
    expect(second.status).toBe(200)
    expect(secondBody.user.id).toBe(firstBody.user.id)
    const me=await request('me',{cookie:cookieOf(second)})
    expect(await me.json()).toMatchObject({user:{id:firstBody.user.id},session:{method:'privy'}})
  })

  it('allows a Privy wallet-only account to onboard while verified email is required',async()=>{
    const login=await request('privy/login',{method:'POST',accessToken:await signedToken(),extra:{REQUIRE_VERIFIED_EMAIL:'true'}})
    expect(login.status).toBe(200)
    expect(await login.clone().json()).toMatchObject({user:{email:null,emailVerified:false},memberships:[],session:{method:'privy'},policy:{requireVerifiedEmail:true}})
    const created=await app().request('https://app.test/api/orgs',{
      method:'POST',
      headers:{cookie:cookieOf(login),'content-type':'application/json'},
      body:JSON.stringify({name:'Privy Merchant',slug:`privy-${crypto.randomUUID().slice(0,8)}`,industry:'Software',country:'US'}),
    },await testBindings({REQUIRE_VERIFIED_EMAIL:'true'}))
    expect(created.status).toBe(201)
  })

  it('rejects bad issuer, audience, expiry, DID, and signatures without creating users',async()=>{
    const countBefore=await db.prepare('SELECT count(*) AS n FROM users').first<number>('n')
    const badTokens=[
      await signedToken({iss:'attacker.example'}),
      await signedToken({aud:'another-app-id'}),
      await signedToken({exp:Math.floor(Date.now()/1000)-20}),
      await signedToken({sub:'not-a-privy-did'}),
    ]
    for(const accessToken of badTokens) expect((await request('privy/login',{method:'POST',accessToken})).status).toBe(401)
    const valid=await signedToken()
    const damaged=`${valid.slice(0,-3)}abc`
    expect((await request('privy/login',{method:'POST',accessToken:damaged})).status).toBe(401)
    const countAfter=await db.prepare('SELECT count(*) AS n FROM users').first<number>('n')
    expect(countAfter).toBe(countBefore)
  })

  it('verifies production JWKS through a local fetch stub and fails closed on provider outage',async()=>{
    const previousFetch=globalThis.fetch
    const jwk={...(await exportJWK((await keysPromise).publicKey)),kid:'privy-test-key',use:'sig',alg:'ES256'}
    let successfulFetches=0
    globalThis.fetch=(input,init)=>{
      successfulFetches++
      const url=input instanceof Request?input.url:input instanceof URL?input.href:input
      expect(url).toBe(`https://api.privy.io/v1/apps/${APP_ID}/jwks.json`)
      const headers=new Headers(init?.headers)
      expect(headers.get('privy-app-id')).toBe(APP_ID)
      expect(headers.get('authorization')).toMatch(/^Basic /)
      return Promise.resolve(new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'content-type':'application/json'}}))
    }
    try {
      const good=await request('privy/login',{method:'POST',accessToken:await signedToken(),extra:{APP_ENV:'production',PRIVY_TEST_VERIFICATION_KEY:undefined}})
      expect(good.status).toBe(200)
      expect(successfulFetches).toBe(1)
    } finally {
      globalThis.fetch=previousFetch
    }

    const before=await db.prepare('SELECT count(*) AS n FROM users').first<number>('n')
    globalThis.fetch=()=>Promise.resolve(new Response('provider unavailable',{status:503}))
    try {
      const failed=await request('privy/login',{method:'POST',accessToken:await signedToken(),extra:{APP_ENV:'production',PRIVY_TEST_VERIFICATION_KEY:undefined}})
      expect(failed.status).toBe(503)
      expect(await db.prepare('SELECT count(*) AS n FROM users').first<number>('n')).toBe(before)
    } finally {
      globalThis.fetch=previousFetch
    }
  })

  it('requires an active RETEMPO session to link and never links by matching email',async()=>{
    const email='same-email@example.test',userId=await insertUser(email)
    const automatic=await request('privy/login',{method:'POST',accessToken:await signedToken({extra:{email}})})
    const automaticBody=await automatic.json() as {user:{id:string;email:string|null}}
    expect(automatic.status).toBe(200)
    expect(automaticBody.user).toMatchObject({email:null})
    expect(automaticBody.user.id).not.toBe(userId)
    expect(await db.prepare('SELECT count(*) AS n FROM users WHERE email=?').bind(email).first<number>('n')).toBe(1)
    const token=await signedToken({extra:{email}}),did=(await import('jose')).decodeJwt(token).sub as string
    expect((await request('privy/link',{method:'POST',accessToken:token})).status).toBe(401)
    const issued=await app().request(`https://app.test/test/password-session/${userId}`,{method:'POST'},await testBindings())
    expect(issued.status).toBe(200)
    const link=await request('privy/link',{method:'POST',accessToken:token,cookie:cookieOf(issued)})
    expect(link.status).toBe(200)
    expect(await db.prepare('SELECT user_id FROM privy_identities WHERE privy_user_id=?').bind(did).first('user_id')).toBe(userId)
    expect(await db.prepare('SELECT count(*) AS n FROM users WHERE email=?').bind(email).first<number>('n')).toBe(1)
    await expect((await request('privy/status',{cookie:cookieOf(issued)})).json()).resolves.toEqual({enabled:true,linked:true})
  })

  it('prevents a DID from being linked to another user and one user from acquiring a second DID',async()=>{
    const firstUser=await insertUser('first-link@example.test'),secondUser=await insertUser('second-link@example.test')
    const firstSession=await app().request(`https://app.test/test/password-session/${firstUser}`,{method:'POST'},await testBindings())
    const secondSession=await app().request(`https://app.test/test/password-session/${secondUser}`,{method:'POST'},await testBindings())
    const didToken=await signedToken(),did=(await import('jose')).decodeJwt(didToken).sub as string
    expect((await request('privy/link',{method:'POST',accessToken:didToken,cookie:cookieOf(firstSession)})).status).toBe(200)
    expect((await request('privy/link',{method:'POST',accessToken:didToken,cookie:cookieOf(secondSession)})).status).toBe(409)
    const otherToken=await signedToken()
    expect((await request('privy/link',{method:'POST',accessToken:otherToken,cookie:cookieOf(firstSession)})).status).toBe(409)
    expect(await db.prepare('SELECT user_id FROM privy_identities WHERE privy_user_id=?').bind(did).first('user_id')).toBe(firstUser)
  })

  it('allows wallet management only when the verified Privy DID matches the active RETEMPO account',async()=>{
    const firstUser=await insertUser('wallet-owner@example.test'),secondUser=await insertUser('other-owner@example.test')
    const firstSession=await app().request(`https://app.test/test/password-session/${firstUser}`,{method:'POST'},await testBindings())
    const secondSession=await app().request(`https://app.test/test/password-session/${secondUser}`,{method:'POST'},await testBindings())
    const firstToken=await signedToken(),firstDid=(await import('jose')).decodeJwt(firstToken).sub as string
    expect((await request('privy/link',{method:'POST',accessToken:firstToken,cookie:cookieOf(firstSession)})).status).toBe(200)

    const allowed=await request('privy/wallet-access',{method:'POST',accessToken:firstToken,cookie:cookieOf(firstSession)})
    expect(allowed.status).toBe(200)
    await expect(allowed.json()).resolves.toEqual({allowed:true})

    const otherSession=await request('privy/wallet-access',{method:'POST',accessToken:firstToken,cookie:cookieOf(secondSession)})
    expect(otherSession.status).toBe(200)
    await expect(otherSession.json()).resolves.toEqual({allowed:false})

    const unlinkedToken=await signedToken()
    const unlinked=await request('privy/wallet-access',{method:'POST',accessToken:unlinkedToken,cookie:cookieOf(firstSession)})
    expect(unlinked.status).toBe(200)
    await expect(unlinked.json()).resolves.toEqual({allowed:false})

    expect((await request('privy/wallet-access',{method:'POST',accessToken:firstToken})).status).toBe(401)
    expect((await request('privy/wallet-access',{method:'POST',cookie:cookieOf(firstSession)})).status).toBe(401)
    expect(await db.prepare('SELECT user_id FROM privy_identities WHERE privy_user_id=?').bind(firstDid).first('user_id')).toBe(firstUser)
    expect(await db.prepare('SELECT count(*) AS n FROM users WHERE id IN (?,?)').bind(firstUser,secondUser).first<number>('n')).toBe(2)
  })

  it('rejects a synthetic verifier key outside test mode before any request can use it',async()=>{
    const invalid=await testBindings({APP_ENV:'production',PRIVY_TEST_VERIFICATION_KEY:(await keysPromise).publicSpki})
    expect(()=>validateBindings(invalid)).toThrow()
  })
})
