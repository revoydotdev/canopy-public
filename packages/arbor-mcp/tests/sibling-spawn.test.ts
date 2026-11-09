import { describe, expect, it } from "vitest";
import { CampaignManager } from "../src/manager.js"; import { ArborRuntime } from "../src/runtime.js"; import { RuntimeCatalogRouter } from "../src/runtime-catalog.js"; import { SiblingSpawner } from "../src/sibling-spawner.js"; import { WorktreeManager } from "@arbor/opencode"; import type { TaskSupervisor } from "@arbor/core";
const root={description:"root",estimated_gain:1,estimated_cost:1,category:"root",delegate_to:"crown"}; const action={...root,description:"child",delegate_to:"seed"};
const meta=(id:string)=>({operation_id:id,idempotency_key:id,correlation_id:id,actor_id:"operator",requested_at:"2026-08-08T00:00:00.000Z"});
describe("sibling.spawn",async ()=>{ it("branches, leases and supervises an isolated bounded child idempotently",async ()=>{ const manager=new CampaignManager();manager.startCampaign("c","p",root); const wt=new WorktreeManager({},true); const runtime=new ArborRuntime({manager,sibling_spawner:(m,s)=>new SiblingSpawner(m,s,wt)});const router=new RuntimeCatalogRouter(runtime);const request={schema_version:1 as const,metadata:meta("op"),command:{kind:"sibling.spawn" as const,campaign_id:"c",parent_node_id:"root",action}}; expect(await router.dispatchCommand(request)).toMatchObject({ok:true,value:{accepted:true,child_node_id:expect.any(String),worktree_path:expect.any(String)}});expect(await router.dispatchCommand(request)).toMatchObject({ok:true,value:{accepted:true}}); }); it("compensates branch when isolation fails and refuses bare/capability-denied calls",async ()=>{const manager=new CampaignManager();manager.startCampaign("c","p",root);const bad={acquireLease:()=>null,releaseLease:()=>true};const runtime=new ArborRuntime({manager,sibling_spawner:(m,s)=>new SiblingSpawner(m,s,bad)});const input={schema_version:1 as const,metadata:meta("bad"),command:{kind:"sibling.spawn" as const,campaign_id:"c",parent_node_id:"root",action}};expect(await new RuntimeCatalogRouter(runtime).dispatchCommand(input)).toMatchObject({ok:true,value:{accepted:false,error:{code:"unavailable"}}});expect(manager.getCampaignSnapshot("c")?.nodes).toHaveLength(2);expect(await new RuntimeCatalogRouter(new ArborRuntime()).dispatchCommand(input)).toMatchObject({ok:false,error:{code:"unavailable"}});});

it("releases a just-acquired lease and records durable compensation when child supervision cannot register",async ()=>{
  const manager=new CampaignManager(); manager.startCampaign("c","p",root);
  const registered:string[]=[]; const unregistered:string[]=[]; const released:string[]=[];
  const supervisor={
    get:(id:string)=>registered.includes(id)?{id}:undefined,
    list:()=>registered.map((id)=>({id,operation_id:id.startsWith("sibling:")?"existing":""})),
    register:(input:{id:string})=>{registered.push(input.id); if(input.id.startsWith("sibling:")) throw new Error("supervisor storage unavailable");},
    unregister:(id:string)=>{unregistered.push(id); return true;},
  } as unknown as TaskSupervisor;
  const worktrees={acquireLease:(_input:{node_id:string})=>({node_id:"leased",path:"/isolated/child",starting_commit:"abc"}),releaseLease:(node_id:string)=>{released.push(node_id);return true;}};
  const runtime=new ArborRuntime({manager,supervisor,sibling_spawner:(m,s)=>new SiblingSpawner(m,s,worktrees)});
  const result=await new RuntimeCatalogRouter(runtime).dispatchCommand({schema_version:1 as const,metadata:meta("register-fails"),command:{kind:"sibling.spawn" as const,campaign_id:"c",parent_node_id:"root",action}});
  expect(result).toMatchObject({ok:true,value:{accepted:false,error:{code:"unavailable"}}});
  expect(released).toHaveLength(1); expect(unregistered).toHaveLength(1);
  expect(runtime.operations.get("register-fails")).toMatchObject({state:"rejected"});
  expect(manager.getCampaignSnapshot("c")?.nodes.find((node)=>node.id!=="root")?.gate_records)
    .toEqual(expect.arrayContaining([expect.objectContaining({gate:"isolation",result:"bypass"})]));
});
});
