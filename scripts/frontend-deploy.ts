#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { CID } from "multiformats/cid";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDotEnvIfPresent, requiredEnv } from "./lib/env.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const ENS_NAME_DEFAULT = "kinzoku.rmrk.eth";
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

const ENS_REGISTRY_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "resolver",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "resolver", type: "address" }],
  },
  {
    type: "function",
    name: "setResolver",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
] as const;

const RESOLVER_ABI = [
  {
    type: "function",
    name: "setContenthash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "hash", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "contenthash",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "hash", type: "bytes" }],
  },
] as const;

const ADDR_RESOLVER_ABI = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "addr", type: "address" }],
  },
] as const;

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

function bytes32Hex(buf: Buffer) {
  if (buf.length !== 32) throw new Error(`Expected 32 bytes, got ${buf.length}`);
  return ("0x" + buf.toString("hex")) as `0x${string}`;
}

function ensNamehash(name: string): `0x${string}` {
  const te = new TextEncoder();
  let node = Buffer.alloc(32, 0);
  const labels = String(name || "")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();

  for (const label of labels) {
    const labelHashHex = keccak256(te.encode(label));
    const labelHash = Buffer.from(labelHashHex.slice(2), "hex");
    const combined = Buffer.concat([node, labelHash]);
    const nodeHex = keccak256(combined);
    node = Buffer.from(nodeHex.slice(2), "hex");
  }

  return bytes32Hex(node);
}

function ensContenthashFromIpfsCid(cidStr: string): `0x${string}` {
  // ENS contenthash uses multicodec: varint(ipfs-ns=0xe3) + CID bytes.
  // varint(0xe3) = 0xe3 0x01.
  const ipfsNsPrefix = Buffer.from([0xe3, 0x01]);
  let cid = CID.parse(cidStr.trim());
  if (cid.version === 0) cid = cid.toV1(); // ensures bytes include CIDv1 prefix (0x01 0x70 ...)
  const out = Buffer.concat([ipfsNsPrefix, Buffer.from(cid.bytes)]);
  return ("0x" + out.toString("hex")) as `0x${string}`;
}

async function run(cmd: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function buildFrontend() {
  await run("bun", ["run", "frontend:build"], SCRIPTS_DIR);
}

function joinKey(prefix: string, key: string) {
  const p = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return key.replace(/^\/+/, "");
  return `${p}/${key.replace(/^\/+/, "")}`;
}

function mimeFromPath(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".ico")) return "image/x-icon";
  if (p.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function ensureTrailingSlash(url: string) {
  if (!url) return url;
  return url.endsWith("/") ? url : `${url}/`;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walkFiles(p)));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

async function uploadFileToFilebase(opts: {
  s3: S3Client;
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
}) {
  await opts.s3.send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
    }),
  );

  // Filebase may attach the CID asynchronously; poll a bit.
  let cid = "";
  let lastMetaKeys: string[] = [];
  for (let attempt = 1; attempt <= 30; attempt++) {
    const head = await opts.s3.send(new HeadObjectCommand({ Bucket: opts.bucket, Key: opts.key }));
    const meta = head.Metadata ?? {};
    lastMetaKeys = Object.keys(meta);
    cid =
      meta.cid ||
      meta["ipfs-cid"] ||
      meta["ipfs-hash"] ||
      meta["ipfshash"] ||
      meta["x-amz-meta-cid"] ||
      "";
    if (cid) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!cid) {
    throw new Error(
      `Uploaded ${opts.bucket}/${opts.key}, but could not find CID in object metadata after waiting.\n` +
        `Expected something like Metadata.cid. Received keys: ${lastMetaKeys.join(", ") || "(none)"}`,
    );
  }

  return cid;
}

function rewriteAssetPathsToGatewayUrls(html: string, assetUrlByRelPath: Record<string, string>) {
  const entries = Object.entries(assetUrlByRelPath).sort(([a], [b]) => b.length - a.length);
  for (const [p, url] of entries) {
    // Replace the longer "./assets/…" first to avoid producing "./https://…"
    html = html.split(`./${p}`).join(url);
    html = html.split(p).join(url);
  }
  return html;
}

async function uploadFrontendToFilebaseAndReturnCid() {
  const bucket = requiredEnv("FILEBASE_BUCKET");
  const prefix = requiredEnv("FILEBASE_BUCKET_KEY");
  const endpoint = process.env.FILEBASE_ENDPOINT || "https://s3.filebase.com";
  const accessKeyId = requiredEnv("FILEBASE_ROOT_KEY");
  const secretAccessKey = requiredEnv("FILEBASE_ROOT_SECRET");

  const s3 = new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const distDir = join(REPO_ROOT, "dist");
  const distAssetsDir = join(distDir, "assets");

  const gatewayBase = ensureTrailingSlash(process.env.FILEBASE_IPFS_GATEWAY || "https://ipfs.filebase.io/ipfs/");

  const assetUrlByRelPath: Record<string, string> = {};
  try {
    const files = await walkFiles(distAssetsDir);
    if (files.length) {
      console.log(`Uploading ${files.length} frontend asset(s) to Filebase…`);
    }
    for (const absPath of files) {
      const relPath = relative(distDir, absPath).replace(/\\/g, "/"); // e.g. assets/compare.jpg
      const key = joinKey(prefix, relPath);
      const body = await readFile(absPath);
      const cid = await uploadFileToFilebase({
        s3,
        bucket,
        key,
        body,
        contentType: mimeFromPath(absPath),
      });
      assetUrlByRelPath[relPath] = `${gatewayBase}${cid}`;
    }
  } catch (err: any) {
    // dist/assets may not exist if the user hasn't run frontend:build yet.
    // We'll still deploy index.html, but it may reference missing assets.
    console.warn(`Warning: could not upload dist/assets (${err?.message || err}). Proceeding with index.html only.`);
  }

  const indexKey = joinKey(prefix, "index.html");
  let html = await readFile(join(distDir, "index.html"), "utf8");
  html = rewriteAssetPathsToGatewayUrls(html, assetUrlByRelPath);

  const cid = await uploadFileToFilebase({
    s3,
    bucket,
    key: indexKey,
    body: Buffer.from(html, "utf8"),
    contentType: "text/html; charset=utf-8",
  });

  return { bucket, key: indexKey, cid };
}

async function getCanonicalPublicResolver(publicClient: ReturnType<typeof createPublicClient>) {
  // ENS convention: `resolver.eth` resolves to the canonical PublicResolver contract address.
  const resolverEthNode = ensNamehash("resolver.eth");
  const resolverForResolverEth = await publicClient.readContract({
    address: ENS_REGISTRY,
    abi: ENS_REGISTRY_ABI,
    functionName: "resolver",
    args: [resolverEthNode],
  });

  if (!resolverForResolverEth || resolverForResolverEth.toLowerCase() === ZERO_ADDR) {
    throw new Error(`ENS registry has no resolver set for resolver.eth (node ${resolverEthNode})`);
  }

  const publicResolver = await publicClient.readContract({
    address: resolverForResolverEth,
    abi: ADDR_RESOLVER_ABI,
    functionName: "addr",
    args: [resolverEthNode],
  });

  if (!publicResolver || publicResolver.toLowerCase() === ZERO_ADDR) {
    throw new Error(`resolver.eth has no addr record (node ${resolverEthNode}, resolver ${resolverForResolverEth})`);
  }

  return publicResolver;
}

async function updateEnsContenthash(opts: { name: string; cid: string; autoSwitchResolver?: boolean }) {
  const privateKey = requiredEnv("PRIVATE_KEY");
  const rpcUrl = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  const node = ensNamehash(opts.name);
  const chainId = await publicClient.getChainId();
  const registryOwner = await publicClient.readContract({
    address: ENS_REGISTRY,
    abi: ENS_REGISTRY_ABI,
    functionName: "owner",
    args: [node],
  });
  const resolver = await publicClient.readContract({
    address: ENS_REGISTRY,
    abi: ENS_REGISTRY_ABI,
    functionName: "resolver",
    args: [node],
  });

  console.log(`ENS debug:`);
  console.log(`- RPC:      ${rpcUrl}`);
  console.log(`- Chain ID:  ${chainId}`);
  console.log(`- Name:      ${opts.name}`);
  console.log(`- Node:      ${node}`);
  console.log(`- Sender:    ${account.address}`);
  console.log(`- ENS owner: ${registryOwner}`);
  console.log(`- Resolver:  ${resolver}`);

  if (registryOwner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY address (${account.address}) is not the ENS owner for ${opts.name}.\n` +
        `ENS registry owner is ${registryOwner} (node ${node}).`,
    );
  }

  const contenthash = ensContenthashFromIpfsCid(opts.cid);
  const autoSwitch = opts.autoSwitchResolver !== false;

  let targetResolver = resolver;
  if (!targetResolver || targetResolver.toLowerCase() === ZERO_ADDR) {
    if (!autoSwitch) {
      throw new Error(`ENS resolver not set for ${opts.name} (node ${node}).`);
    }
    targetResolver = await getCanonicalPublicResolver(publicClient);
    console.log(`Resolver not set; setting resolver to canonical PublicResolver: ${targetResolver}`);
    const setTx = await walletClient.writeContract({
      address: ENS_REGISTRY,
      abi: ENS_REGISTRY_ABI,
      functionName: "setResolver",
      args: [node, targetResolver],
    });
    const setReceipt = await publicClient.waitForTransactionReceipt({ hash: setTx });
    if (setReceipt.status !== "success") throw new Error(`ENS setResolver tx failed: ${setTx}`);
  }

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: targetResolver,
      abi: RESOLVER_ABI,
      functionName: "setContenthash",
      args: [node, contenthash],
    });
  } catch (err: any) {
    if (!autoSwitch) throw err;

    const publicResolver = await getCanonicalPublicResolver(publicClient);
    if (targetResolver.toLowerCase() !== publicResolver.toLowerCase()) {
      console.log(`Current resolver rejected setContenthash; switching resolver to canonical PublicResolver…`);
      console.log(`- New resolver: ${publicResolver}`);

      const setTx = await walletClient.writeContract({
        address: ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "setResolver",
        args: [node, publicResolver],
      });
      const setReceipt = await publicClient.waitForTransactionReceipt({ hash: setTx });
      if (setReceipt.status !== "success") {
        throw new Error(`ENS setResolver tx failed: ${setTx}`);
      }
      targetResolver = publicResolver;
    }

    txHash = await walletClient.writeContract({
      address: targetResolver,
      abi: RESOLVER_ABI,
      functionName: "setContenthash",
      args: [node, contenthash],
    });
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`ENS setContenthash tx failed: ${txHash}`);
  }

  const verify = await publicClient.readContract({
    address: targetResolver,
    abi: RESOLVER_ABI,
    functionName: "contenthash",
    args: [node],
  });

  return { txHash, resolver: targetResolver, contenthash: verify };
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);

  const args = parseArgs(process.argv.slice(2));
  const name = String(args.name || process.env.ENS_NAME || ENS_NAME_DEFAULT);
  const dryRun = Boolean(args["dry-run"] || process.env.DRY_RUN === "1");
  const skipEns = Boolean(args["skip-ens"] || process.env.SKIP_ENS === "1");
  const providedCid = args.cid ? String(args.cid) : "";
  const noResolverSwitch = Boolean(args["no-resolver-switch"] || process.env.NO_RESOLVER_SWITCH === "1");

  console.log(`Building frontend…`);
  await buildFrontend();

  let cid = "";
  if (providedCid) {
    cid = providedCid;
    console.log(`Using provided CID (skipping Filebase upload): ${cid}`);
  } else {
    console.log(`Uploading frontend to Filebase (index.html + assets)…`);
    const uploaded = await uploadFrontendToFilebaseAndReturnCid();
    cid = uploaded.cid;
    console.log(`Pinned on Filebase IPFS:`);
    console.log(`- Bucket: ${uploaded.bucket}`);
    console.log(`- Key:    ${uploaded.key}`);
    console.log(`- CID:    ${cid}`);
  }

  if (dryRun || skipEns) {
    console.log(`Skipping ENS update (${dryRun ? "--dry-run" : "SKIP_ENS=1"}).`);
    return;
  }

  console.log(`Updating ENS contenthash for ${name}…`);
  const { txHash, resolver } = await updateEnsContenthash({ name, cid, autoSwitchResolver: !noResolverSwitch });
  console.log(`ENS updated:`);
  console.log(`- Resolver: ${resolver}`);
  console.log(`- Tx:       ${txHash}`);
  console.log(`Done. (Your gateway URL should update once caches refresh.)`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

