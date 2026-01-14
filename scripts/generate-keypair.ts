#!/usr/bin/env bun

/**
 * One-time keypair generation for Kinzoku claim encryption.
 * Run ONCE, save output securely.
 * 
 * Usage: bun run keygen
 */

import nacl from "tweetnacl";

function toBase64(arr: Uint8Array): string {
  return Buffer.from(arr).toString("base64");
}

const keypair = nacl.box.keyPair();

const publicKeyB64 = toBase64(keypair.publicKey);
const secretKeyB64 = toBase64(keypair.secretKey);

console.log("=".repeat(60));
console.log("KINZOKU ENCRYPTION KEYPAIR");
console.log("=".repeat(60));
console.log("");
console.log("PUBLIC KEY (put this in index.html):");
console.log(publicKeyB64);
console.log("");
console.log("SECRET KEY (keep this safe, never share!):");
console.log(secretKeyB64);
console.log("");
console.log("=".repeat(60));

const keyfile = {
  publicKey: publicKeyB64,
  secretKey: secretKeyB64,
  generatedAt: new Date().toISOString(),
  warning: "NEVER commit this file or share the secretKey!",
};

await Bun.write("kinzoku-keys.json", JSON.stringify(keyfile, null, 2));
console.log("\nKeys saved to: kinzoku-keys.json");
console.log("Add this file to .gitignore immediately!");
