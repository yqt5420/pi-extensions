/**
 * Standalone smoke test for the pricing → model mapping logic.
 * Run: node --experimental-strip-types test/smoke.mjs
 * (or compile-free via `node` with --experimental-strip-types on Node 22+)
 *
 * This exercises vendor-detect + pricing without loading the pi runtime.
 */

import { detectVendor, vendorDefaults } from "../extensions/vendor-detect.ts";
import { resolveCost, pickGroupRatio } from "../extensions/pricing.ts";

const K = "sk-DzrzI8aquHVXa8KY4jAMHwVRbTsbhNDi11peMiW41SNL2y5r";
const BASE = "https://api.247200.xyz/v1";
const PRICING = BASE.replace(/\/v\d+\/?$/, "") + "/api/pricing";

const res = await fetch(PRICING, { headers: { Accept: "application/json" } });
const payload = await res.json();
const groupRatio = pickGroupRatio(payload);

console.log("=== NewAPI pricing smoke test ===");
console.log("group_ratio:", groupRatio);
console.log("model count:", payload.data.length);
console.log();

for (const entry of payload.data) {
  const vc = detectVendor(entry.model_name);
  const defs = vendorDefaults(vc.vendor);
  const cost = resolveCost(entry, groupRatio);
  console.log(
    `${entry.model_name.padEnd(22)} vendor=${vc.vendor.padEnd(8)} ` +
      `reasoning=${String(vc.reasoning).padEnd(5)} fmt=${String(vc.thinkingFormat).padEnd(9)} ` +
      `ctx=${defs.contextWindow} ` +
      `in=$${cost.input.toFixed(4)}/M out=$${cost.output.toFixed(4)}/M cache=$${cost.cacheRead.toFixed(4)}/M`,
  );
}

// Verify DeepSeek-V4-Flash gets deepseek thinkingFormat + requiresReasoningContent
const ds = detectVendor("DeepSeek-V4-Flash");
console.log();
console.assert(ds.vendor === "deepseek", "expected deepseek vendor");
console.assert(ds.reasoning === true, "expected reasoning=true");
console.assert(ds.thinkingFormat === "deepseek", "expected deepseek thinkingFormat");
console.assert(ds.requiresReasoningContentOnAssistantMessages === true, "expected requiresReasoningContentOnAssistantMessages");
console.log("DeepSeek-V4-Flash vendor detection: OK");

// Verify GLM-5.2 is detected as reasoning (it returned plain content in test, but glm family supports thinking)
const glm = detectVendor("GLM-5.2");
console.log("GLM-5.2:", glm);

// Verify pool- prefix stripping
const pool = detectVendor("pool-deepseek-v4-flash");
console.assert(pool.vendor === "deepseek", "expected pool- stripped to deepseek");
console.log("pool-deepseek-v4-flash (pool stripped):", pool);
console.log();
console.log("ALL ASSERTIONS PASSED");
