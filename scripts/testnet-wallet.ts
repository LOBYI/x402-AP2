/**
 * Create a fresh payer (agent) wallet and store its key in .env as PAYER_KEY.
 * The key is never printed — only the address, which you fund at https://faucet.circle.com.
 *
 * Run: npm run testnet:wallet
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV = ".env";
if (!existsSync(ENV)) copyFileSync(".env.example", ENV);
chmodSync(ENV, 0o600); // owner-only: holds private keys
const current = readFileSync(ENV, "utf8");
const existing = current.match(/^PAYER_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];

if (existing) {
  console.log(`PAYER_KEY already set in .env → payer ${privateKeyToAccount(existing as `0x${string}`).address} (not overwritten)`);
} else {
  const key = generatePrivateKey();
  // Fill the empty placeholder if present, otherwise append.
  const next = /^PAYER_KEY=[ \t]*$/m.test(current)
    ? current.replace(/^PAYER_KEY=[ \t]*$/m, `PAYER_KEY=${key}`)
    : `${current}${current.endsWith("\n") ? "" : "\n"}PAYER_KEY=${key}\n`;
  writeFileSync(ENV, next);
  console.log(`payer wallet created → ${privateKeyToAccount(key).address}  (key saved to .env)`);
}
console.log(`
next:
  1. https://faucet.circle.com → "Ethereum Sepolia" → send USDC to the payer address above
  2. put your Sepolia-ETH wallet key into .env as FACILITATOR_PRIVATE_KEY
  3. npm run testnet:check`);
