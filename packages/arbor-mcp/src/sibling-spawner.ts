import type { Action, TaskSupervisor } from "@arbor/core";
import type { CampaignManager } from "./manager.js";
export interface SpawnLease { node_id:string; path:string; starting_commit:string; }
export interface SpawnWorktrees { acquireLease(input:{campaign_id:string;node_id:string;specialist:string}): SpawnLease|null; releaseLease(node_id:string): boolean; }
export class SiblingSpawner {
  constructor(private readonly manager:CampaignManager, private readonly supervisor:TaskSupervisor, private readonly worktrees:SpawnWorktrees) {}
  spawn(input:{campaign_id:string;parent_node_id:string;action:Action;operation_id:string}): {child_node_id:string;task_id:string;lease:SpawnLease} {
    const parentTask=`sibling-parent:${input.campaign_id}:${input.parent_node_id}`;
    if(!this.supervisor.get(parentTask)) this.supervisor.register({id:parentTask,operation_id:parentTask,kind:"sibling.parent",owner_scope_id:input.campaign_id});
    const existing=this.supervisor.list({include_terminal:true}).find(t=>t.operation_id===input.operation_id);
    if(existing) { const node=existing.id.replace(/^sibling:/,""); const lease=this.worktrees.acquireLease({campaign_id:input.campaign_id,node_id:node,specialist:input.action.delegate_to}); if(!lease) throw new Error("idempotent spawn lease is unavailable"); return {child_node_id:node,task_id:existing.id,lease}; }
    const [child]=this.manager.branch(input.campaign_id,input.parent_node_id,[input.action]); const task=`sibling:${child}`; let lease:SpawnLease|null=null;
    try { lease=this.worktrees.acquireLease({campaign_id:input.campaign_id,node_id:child,specialist:input.action.delegate_to}); if(!lease) throw new Error("worktree isolation unavailable"); this.supervisor.register({id:task,operation_id:input.operation_id,kind:"sibling.spawn",owner_scope_id:input.campaign_id,parent_id:parentTask}); return {child_node_id:child,task_id:task,lease}; }
    catch(error) { const reason=error instanceof Error?error.message:String(error); this.manager.recordSiblingSpawnCompensation(input.campaign_id,child,input.operation_id,reason); if(lease) this.worktrees.releaseLease(child); try{ this.manager.prune(input.campaign_id,child); }catch{} try{ if(this.supervisor.get(task)) this.supervisor.unregister(task); }catch{} throw error; }
  }
}
