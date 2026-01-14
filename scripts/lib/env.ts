import { readFile } from "node:fs/promises";

export async function loadDotEnvIfPresent(dotenvPath: string) {
  try {
    const raw = await readFile(dotenvPath, "utf8");
    for (const line of raw.split(/\r?\n/g)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      // Don't stomp explicit shell env vars.
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // Optional: users may have already loaded .env into their shell.
  }
}

export function requiredEnv(key: string) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

