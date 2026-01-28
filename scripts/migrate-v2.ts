#!/usr/bin/env bun

/**
 * Migrate claim state from an old KinzokuV2 deployment to the current deployment
 * (used when rotating the immutable owner key by redeploying).
 *
 * This relies on the new KinzokuV2 contract exposing:
 *   migrateFrom(address oldContract, uint256[] nftIds)
 *
 * Usage:
 *   bun run migrate-v2 --from 0xOldContract
 *   bun run migrate-v2 --from 0xOldContract --dry-run
 *   bun run migrate-v2 --from 0xOldContract --rpc-url https://...
 *   bun run migrate-v2 --from 0xOldContract --write-rpc-url https://...
 */

import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadDotEnvIfPresent } from "./lib/env.ts";
import { resolveKinzokuAddress } from "./lib/resolve.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const OLD_ABI = parseAbi([
  "function getAllStatuses() view returns (uint8[99])",
  "function getClaim(uint256 nftId) view returns (address claimant, uint8 status, string encryptedPayload)",
]);

const NEW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function getAllStatuses() view returns (uint8[99])",
  "function getClaim(uint256 nftId) view returns (address claimant, uint8 status, string encryptedPayload)",
  "function migrateFrom(address oldContract, uint256[] nftIds) external",
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
  return /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));
}

function toLower(a: string) {
  return String(a || "").toLowerCase();
}

function statusName(n: number) {
  if (n === 0) return "Unclaimed";
  if (n === 1) return "Pending";
  if (n === 2) return "Shipped";
  return `Unknown(${n})`;
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"] || process.env.DRY_RUN === "1");

  const from = String(args.from || args["old-address"] || process.env.OLD_KINZOKU_ADDRESS || "");
  if (!isAddress(from) || toLower(from) === toLower(ZERO_ADDRESS)) {
    throw new Error(
      `Missing/invalid --from old contract address.\n` +
        `Usage: bun run migrate-v2 --from 0xOldContract`,
    );
  }

  const to =
    (typeof args.to === "string" && isAddress(String(args.to)) && String(args.to)) ||
    (await resolveKinzokuAddress({ repoRoot: REPO_ROOT, chainId: 8453 }));

  if (!isAddress(to) || toLower(to) === toLower(ZERO_ADDRESS)) {
    throw new Error(
      `No new deployment found.\n` +
        `Expected deployments/8453.json with key: kinzokuV2\n` +
        `Or pass --to 0xNewContract`,
    );
  }

  const readRpcUrl = String(
    args["rpc-url"] ||
      process.env.BASE_RPC_URL || // prefer paid RPC to avoid 429s while migrating
      process.env.PUBLIC_BASE_RPC_URL ||
      "https://mainnet.base.org",
  );
  const writeRpcUrl = String(args["write-rpc-url"] || process.env.BASE_RPC_URL || readRpcUrl);

  const publicClient = createPublicClient({ chain: base, transport: http(readRpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 8453) {
    throw new Error(`Refusing to run: expected chainId 8453 (Base), got ${chainId}.\n- RPC: ${readRpcUrl}`);
  }

  const fromCode = await publicClient.getBytecode({ address: from as `0x${string}` });
  if (!fromCode || fromCode === "0x") throw new Error(`No contract code at old address ${from}`);
  const toCode = await publicClient.getBytecode({ address: to as `0x${string}` });
  if (!toCode || toCode === "0x") throw new Error(`No contract code at new address ${to}`);

  const statusesOld = (await publicClient.readContract({
    address: from as `0x${string}`,
    abi: OLD_ABI,
    functionName: "getAllStatuses",
  })) as readonly number[];

  const idsToMigrate: bigint[] = [];
  let pending = 0;
  let shipped = 0;
  for (let i = 0; i < 99; i++) {
    const s = Number((statusesOld as any)[i] ?? 0);
    if (s === 1) pending++;
    if (s === 2) shipped++;
    if (s !== 0) idsToMigrate.push(BigInt(i + 1));
  }

  console.log(`Kinzoku v2 → v2 migration`);
  console.log(`- Read RPC:  ${readRpcUrl}`);
  console.log(`- Write RPC: ${writeRpcUrl}`);
  console.log(`- From:      ${from}`);
  console.log(`- To:        ${to}`);
  console.log(`- Old state: ${shipped} shipped, ${pending} pending`);
  console.log(`- IDs:       ${idsToMigrate.length} to migrate`);
  if (idsToMigrate.length) console.log(`- List:      ${idsToMigrate.map((n) => n.toString()).join(" ")}`);
  console.log("");

  if (idsToMigrate.length === 0) {
    console.log("Nothing to migrate (old contract has no non-unclaimed claims).");
    return;
  }

  const v2Owner = await publicClient.readContract({
    address: to as `0x${string}`,
    abi: NEW_ABI,
    functionName: "owner",
  });

  const pk = String(process.env.PRIVATE_KEY || "").trim();
  if (!dryRun && !pk) throw new Error("Missing PRIVATE_KEY (new contract owner key) in env.");
  const account = pk ? privateKeyToAccount(pk as `0x${string}`) : null;

  console.log(`- New owner: ${v2Owner}`);
  console.log(`- Signer:    ${account ? account.address : "(none; dry-run)"}`);
  console.log("");

  if (!dryRun && account && toLower(account.address) !== toLower(v2Owner)) {
    throw new Error(
      `Signer is not the new contract owner.\n` +
        `- owner(): ${v2Owner}\n` +
        `- signer:  ${account.address}`,
    );
  }

  // Show a quick sample of what we're migrating (for confidence).
  const previewIds = idsToMigrate.slice(0, 10);
  console.log(`Preview (first ${previewIds.length}):`);
  for (const id of previewIds) {
    const [claimant, status] = await publicClient.readContract({
      address: from as `0x${string}`,
      abi: OLD_ABI,
      functionName: "getClaim",
      args: [id],
    });
    const short = String(claimant).slice(0, 8) + "..." + String(claimant).slice(-6);
    console.log(`  #${id}: ${statusName(Number(status))} (${short})`);
  }
  console.log("");

  if (dryRun) {
    console.log("Dry-run: not sending tx.");
    return;
  }

  if (!account) throw new Error("Internal error: signer missing");

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(writeRpcUrl),
  });

  console.log(`Sending migrateFrom(...) tx…`);
  const txHash = await walletClient.writeContract({
    address: to as `0x${string}`,
    abi: NEW_ABI,
    functionName: "migrateFrom",
    args: [from as `0x${string}`, idsToMigrate],
  });

  console.log(`Tx: https://basescan.org/tx/${txHash}`);
  console.log("Waiting for confirmation…");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Migration tx failed: ${txHash}`);
  console.log(`✓ Confirmed in block ${receipt.blockNumber}`);

  // Verify status counts match.
  const statusesNew = (await publicClient.readContract({
    address: to as `0x${string}`,
    abi: NEW_ABI,
    functionName: "getAllStatuses",
  })) as readonly number[];

  let pendingNew = 0;
  let shippedNew = 0;
  for (let i = 0; i < 99; i++) {
    const s = Number((statusesNew as any)[i] ?? 0);
    if (s === 1) pendingNew++;
    if (s === 2) shippedNew++;
  }

  console.log("");
  console.log(`New state: ${shippedNew} shipped, ${pendingNew} pending`);
  console.log("Done.");
}

await main();

