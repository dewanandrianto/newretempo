// Diagnostic entry point for fresh loopback fixtures only; never deploy this test Worker.
import { configuration, type Env } from '../src/service';
export default { async fetch(_request:Request,env:Env):Promise<Response>{
 try{return Response.json(await configuration(env,fetch))}
 catch(error){return Response.json({error:String(error),stack:error instanceof Error?error.stack:null},{status:503})}
}};
