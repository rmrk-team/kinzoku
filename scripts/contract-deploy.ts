#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDotEnvIfPresent, requiredEnv } from "./lib/env.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

async function rpcCall(url: string, method: string, params: any[] = [], timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j?.error) throw new Error(j.error?.message || JSON.stringify(j.error));
    return j?.result;
  } finally {
    clearTimeout(t);
  }
}

async function hasCode(rpcUrl: string, address: string): Promise<boolean> {
  const code = await rpcCall(rpcUrl, "eth_getCode", [address, "latest"]);
  const c = String(code || "");
  return c.startsWith("0x") && c.length > 2;
}

async function readDeploymentAddress(chainId: number): Promise<string> {
  const path = join(REPO_ROOT, "deployments", `${chainId}.json`);
  const raw = await readFile(path, "utf8");
  const json = JSON.parse(raw);
  return String(json?.kinzokuV2 || "");
}

async function runForge(args: string[], extraEnv?: Record<string, string>) {
  const env = { ...process.env, ...(extraEnv || {}) };
  await new Promise<void>((resolve, reject) => {
    const p = spawn("forge", args, { cwd: REPO_ROOT, stdio: "inherit", env });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`forge ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  // Required.
  requiredEnv("PRIVATE_KEY");
  const rpcUrl = requiredEnv("BASE_RPC_URL");

  const basescanKey = process.env.BASESCAN_API_KEY || "";
  const verify = Boolean(basescanKey);

  const args = [
    "script",
    "script/Deploy.s.sol:DeployScript",
    "--rpc-url",
    rpcUrl,
    "--broadcast",
    "--retries",
    "10",
    "--delay",
    "20",
    "-vvvv",
  ];

  if (verify) {
    args.push("--verify", "--etherscan-api-key", basescanKey);
  } else {
    console.log("BASESCAN_API_KEY not set; deploying without verification.");
  }

  // Some Foundry flows read ETHERSCAN_API_KEY by default; map Basescan key for convenience.
  const extraEnv: Record<string, string> = {};
  if (basescanKey && !process.env.ETHERSCAN_API_KEY) extraEnv.ETHERSCAN_API_KEY = basescanKey;

  try {
    await runForge(args, extraEnv);
  } catch (err: any) {
    if (!verify) throw err;

    // `forge script --verify` may fail to verify CREATE2 deployments even if the on-chain tx succeeded.
    // Be helpful: check whether code exists at the newly written deployments/8453.json address.
    try {
      const deployed = await readDeploymentAddress(8453);
      if (deployed && /^0x[0-9a-fA-F]{40}$/.test(deployed)) {
        const ok = await hasCode(rpcUrl, deployed);
        if (ok) {
          console.warn("");
          console.warn("Warning: deployment appears SUCCESSFUL, but verification FAILED.");
          console.warn(`- Deployed: ${deployed}`);
          console.warn(`- RPC:      ${rpcUrl}`);
          console.warn("You can retry verification later (Basescan queue can be flaky).");
          // Treat as success.
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    } catch {
      throw err;
    }
  }
  console.log("Done.");
  console.log("Deployment metadata: deployments/8453.json");
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

