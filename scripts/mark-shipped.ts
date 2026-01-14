#!/usr/bin/env bun

/**
 * Mark Kinzoku claims as shipped.
 * 
 * Usage: 
 *   bun run ship 1 5 23
 *   PRIVATE_KEY=0x... bun run ship 1 5 23
 * 
 * PRIVATE_KEY must be in env (prefer via scripts/.env).
 */

import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { join } from "node:path";
import { loadDotEnvIfPresent } from "./lib/env.ts";
import { resolveKinzokuAddress } from "./lib/resolve.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const abi = parseAbi([
  "function markShipped(uint256 nftId) external",
  "function batchMarkShipped(uint256[] nftIds) external",
  "function getClaim(uint256 nftId) view returns (address claimant, uint8 status, string encryptedPayload)",
]);

const STATUS_NAMES = ["Unclaimed", "Pending", "Shipped"];

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  const KINZOKU_ADDRESS = await resolveKinzokuAddress({ repoRoot: REPO_ROOT, chainId: 8453 });
  if (KINZOKU_ADDRESS === "0x0000000000000000000000000000000000000000") {
    console.error("ERROR: No deployment found. Deploy first or set KINZOKU_ADDRESS in the environment.");
    console.error("Expected deployments/8453.json with key: kinzokuV2");
    process.exit(1);
  }

  // Parse NFT IDs
  const args = process.argv.slice(2);
  const nftIds = args
    .join(",")
    .split(/[,\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= 99);

  if (nftIds.length === 0) {
    console.log("Usage: bun run ship <nftId> [nftId...]");
    console.log("Example: bun run ship 1 5 23");
    process.exit(1);
  }

  // Get private key
  let privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("Missing PRIVATE_KEY. Put it in scripts/.env or export it in your shell.");
    process.exit(1);
  }

  if (!privateKey?.startsWith("0x")) {
    console.error("Invalid private key");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Account: ${account.address}`);
  console.log(`Marking: ${nftIds.join(", ")}\n`);

  // Read-only RPC: always use a public Base endpoint by default.
  const READ_RPC_URL = process.env.PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
  // Write RPC: prefer paid Tenderly URL on our side.
  const WRITE_RPC_URL = process.env.BASE_RPC_URL || READ_RPC_URL;

  const publicClient = createPublicClient({
    chain: base,
    transport: http(READ_RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(WRITE_RPC_URL),
  });

  // Check statuses
  const toMark: bigint[] = [];
  console.log("Checking statuses...");

  for (const nftId of nftIds) {
    const [claimant, status] = await publicClient.readContract({
      address: KINZOKU_ADDRESS,
      abi,
      functionName: "getClaim",
      args: [BigInt(nftId)],
    });

    const statusName = STATUS_NAMES[status] || "Unknown";
    const shortAddr = claimant.slice(0, 8) + "..." + claimant.slice(-6);
    console.log(`  #${nftId}: ${statusName} (${shortAddr})`);

    if (status === 1) {
      // Pending
      toMark.push(BigInt(nftId));
    } else if (status === 2) {
      console.log(`    ⚠️  Already shipped`);
    } else if (status === 0) {
      console.log(`    ⚠️  Never claimed`);
    }
  }

  if (toMark.length === 0) {
    console.log("\nNothing to mark.");
    return;
  }

  console.log(`\nSending tx for ${toMark.length} NFT(s)...`);

  const txHash =
    toMark.length === 1
      ? await walletClient.writeContract({
          address: KINZOKU_ADDRESS,
          abi,
          functionName: "markShipped",
          args: [toMark[0]],
        })
      : await walletClient.writeContract({
          address: KINZOKU_ADDRESS,
          abi,
          functionName: "batchMarkShipped",
          args: [toMark],
        });

  console.log(`Tx: https://basescan.org/tx/${txHash}`);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status === "success") {
    console.log(`✓ Confirmed in block ${receipt.blockNumber}`);
  } else {
    console.log("✗ Transaction failed");
    process.exit(1);
  }
}

await main();
