#!/usr/bin/env bun

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadDotEnvIfPresent } from "./lib/env.ts";
import { resolveEncryptionPubkey, resolveKinzokuAddress } from "./lib/resolve.ts";

const SCRIPTS_DIR = import.meta.dir; // .../kinzoku-v2/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DOTENV_PATH = join(SCRIPTS_DIR, ".env");

const FRONTEND_SRC_DIR = join(REPO_ROOT, "src");
const FRONTEND_DIST_DIR = join(REPO_ROOT, "dist");
const INDEX_IN = join(FRONTEND_SRC_DIR, "index.html");
const INDEX_OUT = join(FRONTEND_DIST_DIR, "index.html");

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

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function mimeFromPath(path: string) {
  const p = path.toLowerCase();
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

function dataUri(mime: string, bytes: Uint8Array) {
  const b64 = Buffer.from(bytes).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function rewriteCssUrls(css: string, cssFileDirRel: string, allowMissing: boolean) {
  // Rewrite url(...) to be relative to the frontend root (since we inline CSS into index.html).
  // We intentionally do NOT base64-inline binary assets; they will be deployed separately to IPFS.
  const re = /url\(\s*(['"]?)([^'"()]+)\1\s*\)/g;
  const matches = Array.from(css.matchAll(re));
  const unique = Array.from(new Set(matches.map((m) => m[2] || ""))).filter(Boolean);

  for (const u of unique) {
    // Skip absolute/data URLs.
    if (/^(data:|https?:|#)/i.test(u)) continue;
    const rel = join(cssFileDirRel, u).replace(/\\/g, "/").replace(/^\.\//, "");
    const abs = join(FRONTEND_SRC_DIR, rel);
    if (!(await exists(abs)) && !allowMissing) {
      throw new Error(`CSS references missing asset: ${rel} (from ${cssFileDirRel})`);
    }
    css = css.split(u).join(rel);
  }

  return css;
}

async function replaceAllAsync(
  input: string,
  re: RegExp,
  replacer: (match: RegExpMatchArray & { index: number }) => Promise<string>,
) {
  if (!re.global) throw new Error("replaceAllAsync requires a global regex");
  let out = "";
  let lastIndex = 0;
  for (const m of input.matchAll(re) as any) {
    const idx = m.index as number;
    out += input.slice(lastIndex, idx);
    out += await replacer(m);
    lastIndex = idx + String(m[0]).length;
  }
  out += input.slice(lastIndex);
  return out;
}

async function inlineStylesheets(html: string, allowMissing: boolean) {
  const re = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;
  return await replaceAllAsync(html, re, async (m) => {
    const tag = String(m[0]);
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return tag;
    const href = hrefMatch[1]!;
    if (/^(https?:|data:)/i.test(href)) return tag;

    const rel = href.replace(/^\.\//, "");
    const abs = join(FRONTEND_SRC_DIR, rel);
    if (!(await exists(abs))) {
      if (!allowMissing) {
        throw new Error(`Missing stylesheet: ${href}\nExpected at: ${abs}`);
      }
      return tag;
    }

    const cssDirRel = dirname(rel).replace(/\\/g, "/");
    let css = await readFile(abs, "utf8");
    css = await rewriteCssUrls(css, cssDirRel, allowMissing);
    return `<style>\n${css}\n</style>`;
  });
}

async function inlineScriptSrc(html: string, allowMissing: boolean) {
  const re = /<script\b[^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi;
  return await replaceAllAsync(html, re, async (m) => {
    const tag = String(m[0]);
    const src = String((m as any)[1] || "");
    if (!src || /^(https?:|data:)/i.test(src)) return tag;

    const rel = src.replace(/^\.\//, "");
    const abs = join(FRONTEND_SRC_DIR, rel);
    if (!(await exists(abs))) {
      if (!allowMissing) {
        throw new Error(`Missing script: ${src}\nExpected at: ${abs}`);
      }
      return tag;
    }

    const js = await readFile(abs, "utf8");
    return `<script>\n${js}\n</script>`;
  });
}

function injectRuntimeConfig(html: string, cfg: any) {
  const configScript = `<script>window.__KINZOKU_CONFIG__=${JSON.stringify(cfg)};</script>`;
  const re = /<script\s+type=["']module["']\s*>/i;
  if (!re.test(html)) throw new Error(`Could not find <script type="module"> in ${INDEX_IN}`);
  return html.replace(re, (m) => `${configScript}\n${m}`);
}

async function copyDir(srcDir: string, destDir: string) {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = join(srcDir, ent.name);
    const dest = join(destDir, ent.name);
    if (ent.isDirectory()) {
      await copyDir(src, dest);
    } else if (ent.isFile()) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    }
  }
}

async function main() {
  await loadDotEnvIfPresent(DOTENV_PATH);
  const args = parseArgs(process.argv.slice(2));
  const allowMissing = Boolean(args["allow-missing-assets"] || process.env.ALLOW_MISSING_ASSETS === "1");

  const kinzokuAddress = await resolveKinzokuAddress({ repoRoot: REPO_ROOT, chainId: 8453 });
  const encryptionPubkey = await resolveEncryptionPubkey({ scriptsDir: SCRIPTS_DIR });

  const cfg = {
    kinzokuAddress,
    encryptionPubkey,
    builtAt: new Date().toISOString(),
  };

  let html = await readFile(INDEX_IN, "utf8");
  html = injectRuntimeConfig(html, cfg);

  // Inline styles/scripts referenced from src/ so dist/index.html can be deployed as a single file.
  html = await inlineStylesheets(html, allowMissing);
  html = await inlineScriptSrc(html, allowMissing);

  // Inline specific non-image assets referenced from HTML/JS as literal strings.
  // (We intentionally do NOT inline image assets; those will be pinned separately to IPFS.)
  const replacements: Array<{ from: string; to: string }> = [];

  function addAssetReplacement(p: string, to: string) {
    // Important: replace the longer "./assets/…" form before "assets/…" to avoid producing "./data:…"
    replacements.push({ from: `./${p}`, to });
    replacements.push({ from: p, to });
  }

  // Ethers ESM module import (turn it into a data: URI so the app can import it from a single file).
  {
    const relNoDot = "assets/ethers.min.js";
    const abs = join(FRONTEND_SRC_DIR, relNoDot);
    const referenced = html.includes(`./${relNoDot}`) || html.includes(relNoDot);
    if (!referenced) {
      // Not used by this build; skip.
    } else if (await exists(abs)) {
      const uri = dataUri("text/javascript", await readFile(abs));
      addAssetReplacement(relNoDot, uri);
    } else if (!allowMissing) {
      throw new Error(`Missing required asset: ${relNoDot}\nExpected at: ${abs}`);
    }
  }

  // Sprite JSONs (fetched by the app at runtime).
  for (const p of ["assets/sprites/sprite_thumbs0.json", "assets/sprites/sprite_thumbs1.json"]) {
    const referenced = html.includes(p) || html.includes(`./${p}`);
    if (!referenced) continue;
    const abs = join(FRONTEND_SRC_DIR, p);
    if (await exists(abs)) {
      const uri = dataUri("application/json", await readFile(abs));
      addAssetReplacement(p, uri);
    } else if (!allowMissing) {
      throw new Error(`Missing required asset: ${p}\nExpected at: ${abs}`);
    }
  }

  // Apply replacements.
  for (const r of replacements.sort((a, b) => b.from.length - a.from.length)) {
    html = html.split(r.from).join(r.to);
  }

  await mkdir(FRONTEND_DIST_DIR, { recursive: true });
  // Clean dist/assets so local `dist/index.html` can be served without stale files.
  await rm(join(FRONTEND_DIST_DIR, "assets"), { recursive: true, force: true });
  await writeFile(INDEX_OUT, html, "utf8");
  await copyDir(join(FRONTEND_SRC_DIR, "assets"), join(FRONTEND_DIST_DIR, "assets"));

  console.log("Built:", INDEX_OUT);
  if (kinzokuAddress === "0x0000000000000000000000000000000000000000") {
    console.log("Note: KINZOKU_ADDRESS is zero (no deployment found). Set KINZOKU_ADDRESS or deploy first.");
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

