#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadDotEnvIfPresent, requiredEnv } from "./lib/env.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

async function waitForRpc(url: string, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for Anvil RPC at ${url}`);
}

async function runForgeTest(env: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("forge", ["test", "--match-test", "testFork_", "-vvv"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`forge test failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  requiredEnv("PRIVATE_KEY");
  const upstream = process.env.BASE_RPC_URL || "https://mainnet.base.org";

  const port = Number(process.env.PORT || 8545);
  const rpcUrl = `http://127.0.0.1:${port}`;

  console.log(`Starting Anvil fork of Base…`);
  console.log(`- Upstream: ${upstream}`);
  console.log(`- RPC:      ${rpcUrl}`);

  const anvil = spawn("anvil", ["--fork-url", upstream, "--port", String(port), "--allow-origin", "*"], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env: process.env,
  });

  const cleanup = () => {
    try {
      anvil.kill("SIGTERM");
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForRpc(rpcUrl);
    console.log(`Running fork tests…`);
    await runForgeTest({ RUN_FORK_TESTS: "1", FORK_URL: rpcUrl });
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

