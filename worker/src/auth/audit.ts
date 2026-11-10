import type { Context } from 'hono'
import type { WorkerContext } from '../types'
export function auditStatement(c:Context<WorkerContext>, userId:string|null, action:string, resourceType='user', resourceId:string|null=userId, metadata:Record<string,unknown>={}) {
  return c.env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,actor_type,action,resource_type,resource_id,metadata,ip,user_agent,request_id) VALUES (?,?,'user',?,?,?,?,?,?,?)").bind(crypto.randomUUID(),userId,action,resourceType,resourceId,JSON.stringify(metadata),c.get('ip'),c.req.header('user-agent')?.slice(0,300)??null,c.get('requestId'))
}
export async function audit(c:Context<WorkerContext>, userId:string|null, action:string, resourceType='user', resourceId:string|null=userId, metadata:Record<string,unknown>={}) { await auditStatement(c,userId,action,resourceType,resourceId,metadata).run() }
