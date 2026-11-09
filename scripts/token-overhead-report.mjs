#!/usr/bin/env bun
import { globSync } from "glob";
const files = globSync(".arbor/audit/*.jsonl");
const rows=[];
const noProgress=[];
for (const file of files) for (const line of (await Bun.file(file).text()).split("\n")) {
  try { const j=JSON.parse(line), o=j.observation; if (o?.type === "usage_cost") { rows.push({file,input:o.input_tokens??0,output:o.output_tokens??0,cacheRead:o.cache_read_tokens??0,cacheWrite:o.cache_write_tokens??0,priced:o.cost?.kind !== "unpriced",progress:o.produced_verified_progress}); if (o.produced_verified_progress === false) noProgress.push(file); } } catch {}
}
rows.sort((a,b)=>b.cacheRead-a.cacheRead);
const sum=k=>rows.reduce((n,r)=>n+r[k],0);
const report={files:rows.length,total:{input:sum("input"),output:sum("output"),cacheRead:sum("cacheRead"),cacheWrite:sum("cacheWrite")},pricedCoverage:rows.length?rows.filter(r=>r.priced).length/rows.length:1,top:rows.slice(0,20),generatedAt:new Date().toISOString(),noProgressSpans:[...new Set(noProgress)]};
console.log(JSON.stringify(report,null,2));
