#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadDotEnvIfPresent } from "./lib/env.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const DEFAULT_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const KANARIA_BASE = "0x011ff409BC4803eC5cFaB41c3Fd1db99fD05c004";
const LOCAL_EXPECTED_KINZOKU = "0xC5273AbFb36550090095B1EDec019216AD21BE6c";

async function rpcCall(url: string, method: string, params: any[] = [], timeoutMs = 2000): Promise<any> {
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

async function waitForRpc(url: string, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await rpcCall(url, "eth_chainId", [], 800);
      return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for Anvil RPC at ${url}`);
}

async function execCapture(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    p.stderr.on("data", (d) => err.push(Buffer.from(d)));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}).\n${Buffer.concat(err).toString("utf8")}`));
    });
  });
}

async function derivePrivateKeyFromMnemonic(mnemonic: string, index: number): Promise<string> {
  // Foundry provides `cast wallet private-key` which works consistently across environments.
  const out = await execCapture(
    "cast",
    ["wallet", "private-key", "--mnemonic", mnemonic, "--mnemonic-index", String(index)],
    REPO_ROOT,
    process.env,
  );
  const pk = out
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-1)[0];
  if (!pk || !pk.startsWith("0x")) throw new Error("Failed to derive private key from mnemonic (cast output unexpected)");
  return pk;
}

async function getNonce(url: string, address: string): Promise<number> {
  const hex = await rpcCall(url, "eth_getTransactionCount", [address, "latest"], 1500);
  const s = String(hex || "");
  if (!s.startsWith("0x")) return 0;
  return Number.parseInt(s.slice(2) || "0", 16);
}

async function trySetNonce(url: string, address: string, nonce: number): Promise<boolean> {
  // Best-effort; Anvil supports this, but ignore if unavailable.
  try {
    const hex = "0x" + Math.max(0, nonce).toString(16);
    await rpcCall(url, "anvil_setNonce", [address, hex], 1500);
    return true;
  } catch {
    return false;
  }
}

async function hasCode(url: string, address: string): Promise<boolean> {
  const code = await rpcCall(url, "eth_getCode", [address, "latest"], 1500);
  const c = String(code || "");
  return c.startsWith("0x") && c.length > 2;
}

async function runForgeCreateDeploy(opts: {
  rpcUrl: string;
  privateKey: string;
  owner: string;
  kanaria: string;
}) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      "forge",
      [
        "create",
        "--broadcast",
        "solidity/KinzokuV2.sol:KinzokuV2",
        "--rpc-url",
        opts.rpcUrl,
        "--private-key",
        opts.privateKey,
        "--constructor-args",
        opts.owner,
        opts.kanaria,
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        // Be defensive: some users keep DRY_RUN=1 in their shell/.env for frontend deploy scripts.
        // Forge create uses "dry run" as the default unless broadcast is enabled; ensure we don't
        // accidentally force dry-run via environment.
        env: {
          ...process.env,
          DRY_RUN: "",
          FOUNDRY_DRY_RUN: "",
          ETHERSCAN_API_KEY: "",
          BASESCAN_API_KEY: "",
        },
      },
    );
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`forge create failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  const upstream = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const port = Number(process.env.PORT || 8545);
  const chainId = Number(process.env.CHAIN_ID || 31337);
  // IMPORTANT: keep these fixed so the local deploy address stays deterministic and matches the frontend hardcode.
  const mnemonic = DEFAULT_MNEMONIC;
  const mnemonicIndex = 0;

  const args = [
    "--fork-url",
    upstream,
    "--port",
    String(port),
    "--chain-id",
    String(chainId),
    "--mnemonic",
    mnemonic,
    "--allow-origin",
    "*",
  ];

  const forkBlock = process.env.FORK_BLOCK_NUMBER;
  if (forkBlock) args.push("--fork-block-number", String(forkBlock));

  console.log(`Starting Anvil fork of Base…`);
  console.log(`- Upstream:    ${upstream}`);
  console.log(`- Chain ID:    ${chainId}`);
  console.log(`- RPC:         http://127.0.0.1:${port}`);
  console.log(`- Fork block:  ${forkBlock || "(latest)"}`);
  console.log("");
  console.log(`This command also deploys KinzokuV2 on the fork so the frontend can read owners/statuses locally.`);

  const anvil = spawn("anvil", args, { stdio: "inherit", cwd: REPO_ROOT, env: process.env });

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

  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForRpc(rpcUrl);

  // Deploy the contract using the first mnemonic account (funded by Anvil).
  const deployerPk = await derivePrivateKeyFromMnemonic(mnemonic, mnemonicIndex);
  const deployerAddrOut = await execCapture("cast", ["wallet", "address", "--private-key", deployerPk], REPO_ROOT, process.env);
  const deployerAddrMatch = deployerAddrOut.match(/0x[0-9a-fA-F]{40}/);
  const deployerAddr = deployerAddrMatch ? deployerAddrMatch[0] : "";

  console.log("");
  console.log("Deploying KinzokuV2 to the fork (deterministic CREATE, nonce 0)…");
  if (deployerAddr) console.log(`- Deployer:    ${deployerAddr} (mnemonic index ${mnemonicIndex})`);
  console.log(`- Expected:    ${LOCAL_EXPECTED_KINZOKU}`);

  const kanaria = process.env.KANARIA_ADDRESS || KANARIA_BASE;

  // Ensure deployer nonce is 0 so the address is deterministic (best-effort).
  if (deployerAddr) {
    const before = await getNonce(rpcUrl, deployerAddr);
    if (before !== 0) {
      const ok = await trySetNonce(rpcUrl, deployerAddr, 0);
      const after = await getNonce(rpcUrl, deployerAddr);
      console.log(`- Deployer nonce: ${before} → ${after}${ok ? "" : " (could not force-set; proceeding)"}`);
    }
  }

  await runForgeCreateDeploy({ rpcUrl, privateKey: deployerPk, owner: deployerAddr, kanaria });

  // Verify the contract is actually deployed at the expected address.
  const ok = await hasCode(rpcUrl, LOCAL_EXPECTED_KINZOKU);
  if (!ok) {
    throw new Error(
      `KinzokuV2 not found at expected local address.\n` +
        `Expected: ${LOCAL_EXPECTED_KINZOKU}\n` +
        `RPC: ${rpcUrl}\n` +
        `Try killing Anvil and re-running \`bun run anvil\`.`,
    );
  }
  console.log(`KinzokuV2 deployed: ${LOCAL_EXPECTED_KINZOKU}`);

  console.log("");
  console.log("Done. Keep this terminal running. Serve the frontend from localhost to use the fork.");

  // Keep running until Anvil exits.
  await new Promise<void>((resolve) => anvil.on("exit", () => resolve()));
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

