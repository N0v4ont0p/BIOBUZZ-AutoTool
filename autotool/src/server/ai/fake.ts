// TESTING ONLY (AUTOTOOL_FAKE_MODEL=1): a stand-in for Claude that answers every task by deciding each
// leg with the rubric in code, through the real agent loop and tools. No API calls, no cost. It cannot
// read a typed request; it is for checking the UI flow and running a usability test offline.

import type Anthropic from "@anthropic-ai/sdk";
import { autoStops, evidenceFor } from "../../shared/stops.ts";
import { featureSheet } from "../../shared/patch.ts";
import type { RobotModel } from "../../shared/profile.ts";
import type { SeasonPack } from "../../shared/season.ts";
import type { AutoSpec } from "../../shared/spec.ts";
import type { MessageClient } from "./agent.ts";

export function rubricClient(spec: AutoSpec, pack: SeasonPack, model: RobotModel): MessageClient {
  let step = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const msg = (content: unknown[]) => ({ id: `fake${step}`, type: "message", role: "assistant", model: "fake", content, stop_reason: "tool_use", stop_sequence: null, usage }) as unknown as Anthropic.Message;
  return {
    async create(): Promise<Anthropic.Message> {
      step++;
      if (step === 1) return msg([{ type: "tool_use", id: `f${Date.now()}a`, name: "get_features", input: {} }]);
      const r = autoStops(spec, pack, model);
      const f = r.features;
      const sheet = featureSheet(f);
      const junctions = r.decisions.map((d) => {
        const j = f.junctions.find((x) => x.id === d.junction)!;
        return { junction: d.junction, evidence: evidenceFor(j, f.legs[j.index], model), during: d.during, end: d.end, ...(d.end === "WAIT" ? { waitS: spec.legs.find((l) => l.id === d.junction)?.waitS ?? 1 } : {}), ...(d.review ? { review: true } : {}), reason: `Rubric row ${d.rule.split(" ")[0]}: ${d.rule.slice(2)}.` };
      });
      return msg([{ type: "tool_use", id: `f${Date.now()}b`, name: "submit_patch", input: { summary: `(Test model, no AI) Decided ${junctions.length} legs with the code rubric; total ${sheet["total.time"]} s.`, junctions, ops: [], claims: [{ ref: "total.junctions", value: junctions.length }, { ref: "total.time", value: sheet["total.time"] }] } }]);
    },
  };
}
