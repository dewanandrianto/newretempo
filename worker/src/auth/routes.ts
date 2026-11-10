import { z } from 'zod'
import type { Context } from 'hono'
import type { WorkerApp, WorkerContext } from '../types'
import { readBody } from '../http'
import { authenticatePassword, registerUser, requestPasswordReset, resendVerification, resetPassword, verifyEmail } from './service'
import { establishSession, expireCookie, revokeSession } from './sessions'
import { issueChallenge, verifyChallenge } from './siwe'
import { linkWalletToUser, loginWithWallet } from './walletAuth'
import { requireWorkerAuth } from './guards'
import { loadWorkerAccount } from './account'
import { consumeRateLimit } from './rateLimits'
import { audit } from './audit'
export { loadWorkerAccount } from './account'
const email=z.string().trim().toLowerCase().max(254).pipe(z.email())
const address=z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/,'Enter a valid wallet address')
const token=z.string().min(20).max(200)
const registerBody=z.object({email,password:z.string().min(1).max(128),name:z.string().trim().min(1,'Enter your name').max(80)})
const loginBody=z.object({email,password:z.string().min(1).max(128)})
const nonceBody=z.object({address})
const verifyBody=z.object({message:z.string().min(1).max(2000),signature:z.string().min(1).max(300)})
async function accountResponse(c:Context<WorkerContext>) {
  const auth=requireWorkerAuth(c)
  return {...await loadWorkerAccount(c,auth.userId),session:{method:auth.method},policy:{requireVerifiedEmail:c.env.REQUIRE_VERIFIED_EMAIL === undefined ? c.env.APP_ENV === 'production' : c.env.REQUIRE_VERIFIED_EMAIL === 'true'}}
}
export function registerAuthRoutes(app:WorkerApp):void {
  app.get('/api/auth/me',async c=>c.json(await accountResponse(c)))
  app.post('/api/auth/register',async c=> {
    const input=await readBody(c,registerBody), result=await registerUser(c,input)
    await establishSession(c,result.proof)
    return c.json({...await accountResponse(c),verificationEmailSent:result.verificationEmailSent},201)
  })
  app.post('/api/auth/login',async c=> {
    const input=await readBody(c,loginBody), proof=await authenticatePassword(c,input)
    await establishSession(c,proof)
    return c.json(await accountResponse(c))
  })
  app.post('/api/auth/logout',async c=> {
    const auth=c.get('auth')
    if (auth) { await revokeSession(c.env.DB,auth.sessionId,'logout'); await audit(c,auth.userId,'auth.logout','session',auth.sessionId) }
    expireCookie(c)
    return c.json({ok:true})
  })
  app.post('/api/auth/verify-email',async c=> { const input=await readBody(c,z.object({token})); await verifyEmail(c,input.token); return c.json({ok:true}) })
  app.post('/api/auth/resend-verification',async c=> { const auth=requireWorkerAuth(c); return c.json({sent:await resendVerification(c,auth.userId,auth.user.email,auth.user.emailVerified)}) })
  app.post('/api/auth/forgot-password',async c=> { const input=await readBody(c,z.object({email})); await requestPasswordReset(c,input.email); return c.json({ok:true}) })
  app.post('/api/auth/reset-password',async c=> { const input=await readBody(c,z.object({token,password:z.string().min(1).max(128)})); await resetPassword(c,input.token,input.password); expireCookie(c); return c.json({ok:true}) })
  app.post('/api/auth/siwe/nonce',async c=> {
    const input=await readBody(c,nonceBody)
    await consumeRateLimit(c.env.DB,`siwe:nonce:${c.get('ip')}`,30,10*60000)
    return c.json(await issueChallenge(c,{...input,purpose:'login'}))
  })
  app.post('/api/auth/siwe/verify',async c=> {
    const input=await readBody(c,verifyBody)
    await consumeRateLimit(c.env.DB,`siwe:verify:${c.get('ip')}`,30,10*60000)
    const wallet=await verifyChallenge(c,{...input,purpose:'login'})
    await establishSession(c,await loginWithWallet(c,wallet))
    return c.json(await accountResponse(c))
  })
  app.post('/api/auth/siwe/link/nonce',async c=> {
    const auth=requireWorkerAuth(c),input=await readBody(c,nonceBody)
    await consumeRateLimit(c.env.DB,`siwe:nonce:${c.get('ip')}`,30,10*60000)
    return c.json(await issueChallenge(c,{...input,purpose:'link',userId:auth.userId}))
  })
  app.post('/api/auth/siwe/link/verify',async c=> {
    const auth=requireWorkerAuth(c),input=await readBody(c,verifyBody)
    await consumeRateLimit(c.env.DB,`siwe:verify:${c.get('ip')}`,30,10*60000)
    const wallet=await verifyChallenge(c,{...input,purpose:'link',userId:auth.userId})
    await linkWalletToUser(c,wallet,auth.userId)
    return c.json(await accountResponse(c))
  })
}
