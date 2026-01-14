#!/usr/bin/env bun

/**
 * Migrate "already claimed" birds from the old Kinzoku v1 contract to the new KinzokuV2
 * by marking them as Shipped on the current chain.
 *
 * Default behavior is tuned for the local Anvil fork started by `bun run anvil`.
 * Use `--base` to run the migration on Base mainnet.
 *
 * Usage:
 *   bun run migrate:v1
 *   bun run migrate:v1 --rpc-url http://127.0.0.1:8545
 *   bun run migrate:v1:base
 *   bun run migrate:v1 --base --dry-run
 *   bun run migrate:v1 --old-address 0x... --new-address 0x...
 *   bun run migrate:v1 --dry-run
 *
 * Notes:
 * - v1 is considered "claimed" if row.requester != 0x0 and row.addresshash != "".
 * - We call `batchMarkShipped` on KinzokuV2 to make these birds non-claimable in v2.
 */

import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { base, foundry } from "viem/chains";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { loadDotEnvIfPresent } from "./lib/env.ts";
import { resolveKinzokuAddress } from "./lib/resolve.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DEFAULT_LOCAL_RPC_URL = "http://127.0.0.1:8545";
const DEFAULT_ANVIL_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Old (v1) contract on Base
const DEFAULT_V1_ADDRESS = "0x5A5B35245be4340b0cC00593baFA0B643Bf91f82";
// New (v2) deterministic local address used by `bun run anvil`
const DEFAULT_V2_LOCAL_ADDRESS = "0xC5273AbFb36550090095B1EDec019216AD21BE6c";

const V1_ABI = parseAbi([
  "function getAllRows() view returns ((address requester, string addresshash, bool confirmed)[99])",
  "function rows(uint256) view returns (address requester, string addresshash, bool confirmed)",
]);

const V2_ABI = parseAbi([
  "function owner() view returns (address)",
  "function getClaim(uint256) view returns (address claimant, uint8 status, string encryptedPayload)",
  "function batchMarkShipped(uint256[] nftIds) external",
]);

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function isAddress(s: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function toLower(a: string) {
  return String(a || "").toLowerCase();
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"] || process.env.DRY_RUN === "1");
  const isBase = Boolean(args.base || args.chain === "base");

  const v1Address = String(args["old-address"] || process.env.KINZOKU_V1_ADDRESS || DEFAULT_V1_ADDRESS);
  const v2Address = isBase
    ? ((await resolveKinzokuAddress({ repoRoot: REPO_ROOT, chainId: 8453 })) as string)
    : String(
        args["new-address"] ||
          process.env.KINZOKU_ADDRESS_LOCAL ||
          process.env.LOCAL_KINZOKU_ADDRESS ||
          DEFAULT_V2_LOCAL_ADDRESS,
      );

  const readRpcUrl = isBase
    ? String(args["rpc-url"] || process.env.BASE_RPC_URL || process.env.PUBLIC_BASE_RPC_URL || "https://mainnet.base.org")
    : String(args["rpc-url"] || process.env.LOCAL_RPC_URL || DEFAULT_LOCAL_RPC_URL);
  const writeRpcUrl = isBase ? String(args["write-rpc-url"] || process.env.BASE_RPC_URL || readRpcUrl) : readRpcUrl;

  if (!isAddress(v1Address)) throw new Error(`Invalid --old-address: ${v1Address}`);
  if (!isAddress(v2Address)) throw new Error(`Invalid --new-address: ${v2Address}`);

  const chain = isBase ? base : foundry;
  const expectedChainId = isBase ? 8453 : 31337;
  const publicClient = createPublicClient({ chain, transport: http(readRpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) {
    throw new Error(
      `Refusing to run: expected chainId ${expectedChainId}, got ${chainId}.\n` +
        `- Mode: ${isBase ? "base" : "local"}\n` +
        `- RPC:  ${readRpcUrl}`,
    );
  }

  const v1Code = await publicClient.getBytecode({ address: v1Address as `0x${string}` });
  if (!v1Code || v1Code === "0x") {
    throw new Error(`No contract code at v1 address ${v1Address} on ${readRpcUrl}`);
  }

  const v2Code = await publicClient.getBytecode({ address: v2Address as `0x${string}` });
  if (!v2Code || v2Code === "0x") {
    throw new Error(`No contract code at v2 address ${v2Address} on ${readRpcUrl}`);
  }

  const v2Owner = await publicClient.readContract({
    address: v2Address as `0x${string}`,
    abi: V2_ABI,
    functionName: "owner",
  });

  // Pick signer
  // IMPORTANT: scripts/.env likely contains a "real" PRIVATE_KEY for mainnet operations.
  // For the local Anvil fork, we default to the fixed mnemonic (same as `bun run anvil`).
  const providedPk = typeof args["private-key"] === "string" ? String(args["private-key"]) : "";
  const useEnvPk = Boolean(args["use-env-private-key"]);

  const envPk = process.env.PRIVATE_KEY || "";
  const mnemonicAccount = mnemonicToAccount(DEFAULT_ANVIL_MNEMONIC, { accountIndex: 0 });
  const envAccount = envPk && envPk.startsWith("0x") ? privateKeyToAccount(envPk as `0x${string}`) : null;

  const defaultAccount = isBase ? envAccount : mnemonicAccount;
  const account =
    providedPk && providedPk.startsWith("0x")
      ? privateKeyToAccount(providedPk as `0x${string}`)
      : (useEnvPk ? envAccount : null) || defaultAccount;

  if (!dryRun && !account) {
    throw new Error(
      `Missing signer.\n` +
        `Base mode requires PRIVATE_KEY (or --private-key).\n` +
        `Local mode defaults to the Anvil mnemonic account.`,
    );
  }

  if (!dryRun && account && toLower(account.address) !== toLower(v2Owner)) {
    throw new Error(
      `Signer is not the KinzokuV2 owner.\n` +
        `- KinzokuV2 owner: ${v2Owner}\n` +
        `- Signer:         ${account.address}\n` +
        `Tip: for Base mode, set PRIVATE_KEY in scripts/.env to the v2 owner.\n` +
        `For local mode, this defaults to the Anvil mnemonic accountIndex=0.`,
    );
  }

  const walletClient = !dryRun && account ? createWalletClient({ account, chain, transport: http(writeRpcUrl) }) : null;

  console.log(`Kinzoku v1 → v2 migration (${isBase ? "base" : "local"})`);
  console.log(`- Read RPC:   ${readRpcUrl}`);
  if (isBase) console.log(`- Write RPC:  ${writeRpcUrl}`);
  console.log(`- v1:         ${v1Address}`);
  console.log(`- v2:         ${v2Address}`);
  console.log(`- v2 owner:   ${v2Owner}`);
  console.log(`- signer:     ${account ? account.address : "(none; dry-run)"}`);
  console.log(`- mode:       ${dryRun ? "dry-run" : "execute"}`);
  console.log("");

  // Scan v1 rows
  const claimed: number[] = [];
  const confirmed: number[] = [];

  // Prefer the one-call getter to avoid rate limits on public RPCs.
  try {
    const allRows: any[] = (await publicClient.readContract({
      address: v1Address as `0x${string}`,
      abi: V1_ABI,
      functionName: "getAllRows",
    })) as any;

    for (let i = 0; i < 99; i++) {
      const r: any = allRows?.[i];
      const requester = r?.requester ?? r?.[0];
      const addresshash = r?.addresshash ?? r?.[1];
      const isConfirmed = r?.confirmed ?? r?.[2];

      const hasRow = toLower(requester) !== ZERO_ADDRESS && String(addresshash || "") !== "";
      if (!hasRow) continue;
      const nftId = i + 1;
      claimed.push(nftId);
      if (Boolean(isConfirmed)) confirmed.push(nftId);
    }
  } catch {
    // Fallback: per-index reads.
    for (let i = 0; i < 99; i++) {
      const [requester, addresshash, isConfirmed] = await publicClient.readContract({
        address: v1Address as `0x${string}`,
        abi: V1_ABI,
        functionName: "rows",
        args: [BigInt(i)],
      });

      const hasRow = toLower(requester) !== ZERO_ADDRESS && String(addresshash || "") !== "";
      if (!hasRow) continue;
      const nftId = i + 1;
      claimed.push(nftId);
      if (isConfirmed) confirmed.push(nftId);
    }
  }

  console.log(`v1 rows: ${claimed.length} claimed (${confirmed.length} confirmed)`);
  if (claimed.length) {
    console.log(`Claimed IDs: ${claimed.join(" ")}`);
  }
  console.log("");

  if (claimed.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // Only send a tx for IDs that aren't already shipped in v2.
  const toMark: bigint[] = [];
  for (const id of claimed) {
    const [, status] = await publicClient.readContract({
      address: v2Address as `0x${string}`,
      abi: V2_ABI,
      functionName: "getClaim",
      args: [BigInt(id)],
    });
    if (Number(status) !== 2) toMark.push(BigInt(id));
  }

  console.log(`v2: ${toMark.length}/${claimed.length} need to be marked shipped`);
  if (toMark.length) {
    console.log(`To mark: ${toMark.map((n) => n.toString()).join(" ")}`);
  }
  console.log("");

  if (toMark.length === 0) {
    console.log("✓ Already migrated (all shipped).");
    return;
  }

  if (dryRun) {
    console.log("Dry-run: not sending tx.");
    return;
  }

  if (!walletClient) throw new Error("Internal error: walletClient missing");

  const txHash = await walletClient.writeContract({
    address: v2Address as `0x${string}`,
    abi: V2_ABI,
    functionName: "batchMarkShipped",
    args: [toMark],
  });

  console.log(`Tx: ${isBase ? `https://basescan.org/tx/${txHash}` : txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Migration tx failed: ${txHash}`);

  console.log(`✓ Confirmed in block ${receipt.blockNumber}`);
}

await main();

