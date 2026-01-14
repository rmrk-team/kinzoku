import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isAddress(s: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function readJsonIfPresent(path: string): Promise<any | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function resolveKinzokuAddress(opts: {
  repoRoot: string;
  chainId?: number;
  envKey?: string;
  jsonKey?: string;
}): Promise<`0x${string}`> {
  const envKey = opts.envKey || "KINZOKU_ADDRESS";
  const fromEnv = process.env[envKey];
  if (fromEnv && isAddress(fromEnv)) return fromEnv as `0x${string}`;

  const chainId = opts.chainId ?? 8453;
  const jsonKey = opts.jsonKey || "kinzokuV2";
  const path = join(opts.repoRoot, "deployments", `${chainId}.json`);
  const json = await readJsonIfPresent(path);

  const addr = String(json?.[jsonKey] || "");
  if (isAddress(addr) && addr !== ZERO_ADDRESS) return addr as `0x${string}`;

  return ZERO_ADDRESS;
}

export async function resolveEncryptionPubkey(opts: {
  scriptsDir: string;
  envKey?: string;
  keyFileName?: string;
}): Promise<string> {
  const envKey = opts.envKey || "ENCRYPTION_PUBKEY";
  const fromEnv = process.env[envKey];
  if (fromEnv) return String(fromEnv);

  const keyFileName = opts.keyFileName || "kinzoku-keys.json";
  const path = join(opts.scriptsDir, keyFileName);
  const json = await readJsonIfPresent(path);
  const pub = String(json?.publicKey || "");
  if (pub) return pub;
  return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // placeholder (all-zero bytes)
}

