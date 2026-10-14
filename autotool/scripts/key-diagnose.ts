// Asks for an API key (hidden), makes a few tiny calls, prints what Anthropic allows. Saves nothing,
// never prints the key. Cost: well under $0.001. Run: node autotool/scripts/key-diagnose.ts
import { createInterface } from "node:readline";

function ask(q: string, hidden: boolean): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); res(a.replace(/[\s"'`]/g, "")); });
  });
}
const key = await ask("API key (hidden): ", true);
const ws = await ask("Workspace ID (Enter if none): ", false);
console.log(`key starts ${key.slice(0, 12)}…, ${key.length} chars`);
const base = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
async function t(name: string, path: string, body: unknown, withWs: boolean) {
  const h: Record<string, string> = { ...base, ...(withWs && ws ? { "anthropic-workspace-id": ws } : {}) };
  const r = await fetch(`https://api.anthropic.com${path}`, { method: body ? "POST" : "GET", headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = (await r.text()).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[key]");
  console.log(`${name.padEnd(26)} ${withWs ? "with ws " : "no ws   "} ${r.status} ${r.status === 200 ? "OK" : txt.slice(0, 170)}`);
}
const msg = (model: string) => ({ model, max_tokens: 8, messages: [{ role: "user", content: "Say OK" }] });
for (const w of ws ? [true, false] : [false]) {
  await t("GET /v1/models", "/v1/models?limit=2", null, w);
  await t("count_tokens haiku-5-5", "/v1/messages/count_tokens", { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] }, w);
  await t("messages haiku-5-5", "/v1/messages", msg("claude-haiku-5-5"), w);
  await t("messages sonnet-5-5", "/v1/messages", msg("claude-sonnet-5-5"), w);
  await t("messages haiku-4-5", "/v1/messages", msg("claude-haiku-4-5"), w);
}
