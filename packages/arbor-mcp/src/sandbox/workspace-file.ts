import type { ConfinementGrade, SandboxBroker } from "./contracts.js";

export type WorkspaceFileOperation =
  /**
   * One bounded window: from byte `offset`, or from the first byte of 1-based
   * `start_line` (found by counting LFs within the first READ_LINE_SEEK_BYTES),
   * else from byte 0. The worker reports where the window starts (`offset`,
   * and `start_line` when it is known) and the file's size; trimming and
   * paging hints are the tool host's.
   */
  | { readonly kind: "read"; readonly path: string; readonly max_bytes: number; readonly offset?: number; readonly start_line?: number }
  | { readonly kind: "write"; readonly path: string; readonly content_base64: string; readonly create: boolean; readonly expected_sha256?: string }
  | { readonly kind: "patch"; readonly path: string; readonly expected: string; readonly replacement: string };

export type WorkspaceFileResult =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly confinement: ConfinementGrade }
  | { readonly ok: false; readonly code: string; readonly confinement: ConfinementGrade };

/** Runs filesystem effects inside the same mount namespace used for hostile commands. */
export async function runWorkspaceFileOperation(input: { readonly broker: SandboxBroker; readonly root: string; readonly writable: boolean; readonly operation: WorkspaceFileOperation; readonly signal: AbortSignal; readonly max_output_bytes: number }): Promise<WorkspaceFileResult> {
  const result = await input.broker.run({
    argv: [process.execPath, "-e", WORKER], cwd: input.root, workspace_root: input.root,
    workspace_writable: input.writable, network_denied: false, timeout_ms: 10_000,
    max_output_bytes: input.max_output_bytes, signal: input.signal,
    stdin: Buffer.from(JSON.stringify(input.operation), "utf8"),
  });
  if (result.kind !== "exited" || result.exit !== 0) return { ok: false, code: result.kind === "exited" ? "workspace_file_failed" : result.kind, confinement: result.confinement };
  try {
    const value = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
    return value.ok === true ? { ok: true, value, confinement: result.confinement } : { ok: false, code: typeof value.code === "string" ? value.code : "workspace_file_failed", confinement: result.confinement };
  } catch { return { ok: false, code: "workspace_file_invalid_response", confinement: result.confinement }; }
}

const WORKER = String.raw`
const f=require('node:fs'),c=require('node:crypto'),p=require('node:path');
let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{try{
 const q=JSON.parse(raw), parts=String(q.path).split(/[\\/]/); if(!q.path||p.isAbsolute(q.path)||parts.some(x=>!x||x==='.'||x==='..'))throw Error('path_invalid');
 const path=p.resolve(process.cwd(),q.path), hash=x=>'sha256:'+c.createHash('sha256').update(x).digest('hex');
 if(q.kind==='read'){const fd=f.openSync(path,'r');try{
  const size=f.fstatSync(fd).size,SEEK=67108864,chunk=Buffer.allocUnsafe(65536);let start=0,line=1;
  const feeds=(from,upto,stopAt)=>{let pos=from,n=0;while(pos<upto){const r=f.readSync(fd,chunk,0,Math.min(65536,upto-pos),pos);if(r===0)break;for(let i=chunk.indexOf(10);i!==-1&&i<r;i=chunk.indexOf(10,i+1)){n++;if(stopAt!==undefined&&n===stopAt)return{n,end:pos+i+1};}pos+=r;}return{n,end:null};};
  if(q.start_line!==undefined){if(q.start_line>1){const hit=feeds(0,Math.min(size,SEEK),q.start_line-1);if(hit.end===null)throw Error(size>SEEK?'read_line_seek_limit':'read_window_out_of_range');start=hit.end;}line=q.start_line;}
  else if(q.offset!==undefined){if(q.offset>size)throw Error('read_window_out_of_range');start=q.offset;line=start<=SEEK?1+feeds(0,start).n:null;}
  const b=Buffer.alloc(Math.max(0,Math.min(q.max_bytes,size-start))),r=b.length===0?0:f.readSync(fd,b,0,b.length,start),w=b.subarray(0,r);
  return out({ok:true,content_base64:w.toString('base64'),bytes:w.length,total_bytes:size,offset:start,start_line:line,truncated:start>0||start+w.length<size});
 }finally{f.closeSync(fd);}}
 if(q.kind==='write'){if(q.create&&f.existsSync(path))throw Error('file_exists');if(q.expected_sha256&&(!f.existsSync(path)||hash(f.readFileSync(path))!==q.expected_sha256))throw Error('stale_write');f.mkdirSync(p.dirname(path),{recursive:true});const b=Buffer.from(q.content_base64,'base64');try{f.writeFileSync(path,b,{mode:384,flag:q.create?'wx':'w'});}catch(e){if(q.create&&e&&e.code==='EEXIST')throw Error('file_exists');throw e;}return out({ok:true,sha256:hash(b)});}
 if(q.kind==='patch'){const t=f.readFileSync(path,'utf8'),i=t.indexOf(q.expected);if(i<0)throw Error('patch_precondition_missing');if(t.indexOf(q.expected,i+q.expected.length)>=0)throw Error('patch_precondition_ambiguous');const n=t.slice(0,i)+q.replacement+t.slice(i+q.expected.length);f.writeFileSync(path,n,{mode:384});return out({ok:true,sha256:hash(n)});}
 throw Error('operation_invalid');
}catch(e){out({ok:false,code:e&&e.message||'workspace_file_failed'});}});function out(x){process.stdout.write(JSON.stringify(x));}
`;
