import { describe, expect, it } from "vitest";
import { parseHeartbeat, validateProviderSoakReelInput } from "../provider-soak-reel.mjs";
const result={status:"passed",termination:"proof_threshold",elapsed_ms:31500,evidence:{proven:true,model_identities:["openrouter/example/model"],provider_usage:{input_tokens:12,output_tokens:4,cached_input_tokens:0,cache_write_input_tokens:0,counter_source:"provider_counter"}}};
describe("provider soak reel",()=>{
  it("derives ordered timing from real heartbeat lines",()=>{const rows=parseHeartbeat("live-provider-soak: 11s · identities 0 · provider tokens 0\nlive-provider-soak: 31s · identities 1 · provider tokens 16\n");expect(rows).toEqual([{at_ms:11000,identities:0,provider_tokens:0},{at_ms:31000,identities:1,provider_tokens:16}]);expect(validateProviderSoakReelInput(result,rows)).toEqual({duration_ms:32500});});
  it("refuses exit-shaped or estimated evidence",()=>{expect(()=>validateProviderSoakReelInput({...result,status:"failed"},[{at_ms:1000,identities:0,provider_tokens:0}])).toThrow(/passed proof-threshold/);expect(()=>validateProviderSoakReelInput({...result,evidence:{...result.evidence,provider_usage:{...result.evidence.provider_usage,counter_source:"estimate"}}},[{at_ms:1000,identities:0,provider_tokens:0}])).toThrow(/provider-counter/);});
});
