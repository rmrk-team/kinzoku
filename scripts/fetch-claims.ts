#!/usr/bin/env bun

/**
 * Fetch and decrypt pending Kinzoku claims.
 * Run weekly to see who needs plates shipped.
 * 
 * Usage:
 *   bun run fetch
 *   bun run fetch:local
 *   bun run fetch --rpc-url https://...
 *   bun run fetch:local --rpc-url http://127.0.0.1:8545 --address 0x...
 * 
 * Requires: kinzoku-keys.json in scripts/ directory
 */

import nacl from "tweetnacl";
import { join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { base, foundry } from "viem/chains";
import { loadDotEnvIfPresent } from "./lib/env.ts";
import { resolveKinzokuAddress } from "./lib/resolve.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const LOCAL_RPC_DEFAULT = "http://127.0.0.1:8545";
const LOCAL_KINZOKU_DEFAULT = "0xC5273AbFb36550090095B1EDec019216AD21BE6c";

const abi = parseAbi([
  "function getAllClaims() view returns (address[99] claimants, uint8[99] statuses, string[99] payloads)",
]);

enum Status {
  Unclaimed = 0,
  Pending = 1,
  Shipped = 2,
}

interface DecryptedClaim {
  nftId: number;
  claimant: string;
  address: string;
  contact: string;
  type: "plexi" | "metal";
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64"));
}

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

function decrypt(encryptedPayload: string, secretKey: Uint8Array): string {
  const data = fromBase64(encryptedPayload);

  // Layout: 24 bytes nonce + 32 bytes ephemeral pubkey + ciphertext
  const nonce = data.slice(0, 24);
  const ephemeralPubKey = data.slice(24, 56);
  const ciphertext = data.slice(56);

  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPubKey, secretKey);

  if (!decrypted) {
    throw new Error("Decryption failed");
  }

  return new TextDecoder().decode(decrypted);
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  const args = parseArgs(process.argv.slice(2));
  const isLocal = Boolean(args.local);

  const rpcFromArg = typeof args["rpc-url"] === "string" ? String(args["rpc-url"]) : "";
  const addrFromArg = typeof args.address === "string" ? String(args.address) : "";

  const KINZOKU_ADDRESS: `0x${string}` = isLocal
    ? ((addrFromArg ||
        process.env.KINZOKU_ADDRESS_LOCAL ||
        process.env.LOCAL_KINZOKU_ADDRESS ||
        LOCAL_KINZOKU_DEFAULT) as `0x${string}`)
    : await resolveKinzokuAddress({ repoRoot: REPO_ROOT, chainId: 8453 });

  if (!isAddress(KINZOKU_ADDRESS) || KINZOKU_ADDRESS === "0x0000000000000000000000000000000000000000") {
    if (isLocal) {
      console.error("ERROR: Invalid local Kinzoku contract address.");
      console.error(`- Default: ${LOCAL_KINZOKU_DEFAULT}`);
      console.error(`- Override: bun run fetch:local --address 0x...`);
      process.exit(1);
    }
    console.error("ERROR: No Base deployment found. Deploy first or set KINZOKU_ADDRESS in the environment.");
    console.error("Expected deployments/8453.json with key: kinzokuV2");
    process.exit(1);
  }

  // Read-only RPC selection
  const RPC_URL = isLocal
    ? rpcFromArg || process.env.LOCAL_RPC_URL || LOCAL_RPC_DEFAULT
    : rpcFromArg || process.env.PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";

  // Load secret key
  let secretKey: Uint8Array;
  try {
    const keysFile = Bun.file("kinzoku-keys.json");
    const keys = await keysFile.json();
    secretKey = fromBase64(keys.secretKey);
  } catch {
    console.error("ERROR: Could not read kinzoku-keys.json");
    console.error("Run `bun run keygen` first.");
    process.exit(1);
  }

  console.log(isLocal ? "Fetching claims from local Anvil...\n" : "Fetching claims from Base...\n");
  console.log(`- RPC:     ${RPC_URL}`);
  console.log(`- Kinzoku: ${KINZOKU_ADDRESS}\n`);

  const client = createPublicClient({
    chain: isLocal ? foundry : base,
    transport: http(RPC_URL),
  });

  const chainId = await client.getChainId();
  if (isLocal && chainId !== 31337) {
    console.warn(`Warning: expected local chainId 31337, got ${chainId}. Is Anvil running on this RPC?\n`);
  }

  const [claimants, statuses, payloads] = await client.readContract({
    address: KINZOKU_ADDRESS,
    abi,
    functionName: "getAllClaims",
  });

  const pendingClaims: DecryptedClaim[] = [];

  for (let i = 0; i < 99; i++) {
    const nftId = i + 1;
    const status = statuses[i];
    const payload = payloads[i];

    if (status !== Status.Pending || !payload) continue;

    try {
      const decrypted = decrypt(payload, secretKey);
      const data = JSON.parse(decrypted);

      pendingClaims.push({
        nftId,
        claimant: claimants[i],
        address: data.address,
        contact: data.contact,
        type: data.type,
      });
    } catch (e) {
      console.error(`Failed to decrypt NFT #${nftId}:`, e);
    }
  }

  // Summary
  const shipped = statuses.filter((s) => s === Status.Shipped).length;
  const pending = statuses.filter((s) => s === Status.Pending).length;
  const unclaimed = 99 - shipped - pending - 3; // -3 for dead eggs

  console.log(`Status: ${shipped} shipped, ${pending} pending, ${unclaimed} unclaimed\n`);

  if (pendingClaims.length === 0) {
    console.log("✓ No pending claims! All caught up.");
    return;
  }

  console.log(`${pendingClaims.length} pending claim(s):\n`);
  console.log("=".repeat(70));

  for (const claim of pendingClaims) {
    console.log(`\nNFT #${claim.nftId} (${claim.type.toUpperCase()})`);
    console.log("-".repeat(40));
    console.log(`Claimant: ${claim.claimant}`);
    console.log(`Contact:  ${claim.contact}`);
    console.log(`Address:\n${claim.address}`);
    console.log("=".repeat(70));
  }

  console.log("\nPending NFT IDs (for mark-shipped):");
  console.log(pendingClaims.map((c) => c.nftId).join(" "));
}

await main();
