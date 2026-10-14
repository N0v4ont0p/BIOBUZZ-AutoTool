import * as prettier from "prettier/standalone";
import type { LanguageSpec } from "./languages/spec";

type Plugin = unknown;

const pluginCache = new Map<string, Promise<Plugin | null>>();

function loadPlugin(specifier: string): Promise<Plugin | null> {
  const cached = pluginCache.get(specifier);
  if (cached) return cached;

  const pending = import(/* @vite-ignore */ specifier)
    .then((module) => (module as { default?: Plugin }).default ?? module)
    .catch((error) => {
      console.warn(`Formatter plugin "${specifier}" unavailable:`, error);
      return null;
    });

  pluginCache.set(specifier, pending);
  return pending;
}

export async function formatSource(
  source: string,
  spec: LanguageSpec,
): Promise<string> {
  try {
    const plugin = await loadPlugin(spec.prettier.pluginSpecifier);
    if (!plugin) return source;
    return await prettier.format(source, {
      parser: spec.prettier.parser,
      plugins: [plugin as never],
    });
  } catch (error) {
    console.warn(`Could not format generated ${spec.id} code:`, error);
    return source;
  }
}
