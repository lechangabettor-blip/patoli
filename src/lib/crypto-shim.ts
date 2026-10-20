/**
 * WebCrypto shim for INSECURE browser contexts (plain http on a LAN address).
 *
 * Browsers expose `crypto.subtle` only on https/localhost. Polymarket's CLOB client
 * needs HMAC-SHA256 (API-key request signing) and SHA-1 (order-book hash), so phone
 * testing over http://192.168.x.x fails with "crypto.subtle is unavailable".
 * On https (the deployed app) this file does nothing. Pure-JS implementations from
 * @noble/hashes, which viem already ships. Only the two calls the client makes.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { sha1 } from "@noble/hashes/sha1";

type HmacKey = { __shim: true; raw: Uint8Array; hash: string };

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function installCryptoShim(): void {
  if (typeof window === "undefined") return;
  if (window.isSecureContext || globalThis.crypto?.subtle) return;
  const subtle = {
    async importKey(format: string, keyData: BufferSource, algorithm: { name: string; hash?: string | { name: string } }): Promise<HmacKey> {
      if (format !== "raw" || algorithm.name !== "HMAC") throw new Error("crypto shim: only raw HMAC keys");
      const hash = typeof algorithm.hash === "string" ? algorithm.hash : (algorithm.hash?.name ?? "SHA-256");
      return { __shim: true, raw: toBytes(keyData), hash };
    },
    async sign(algorithm: string | { name: string }, key: HmacKey, data: BufferSource): Promise<ArrayBuffer> {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name !== "HMAC" || key.hash !== "SHA-256") throw new Error("crypto shim: only HMAC-SHA256");
      const out = hmac(sha256, key.raw, toBytes(data));
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    },
    async digest(algorithm: string | { name: string }, data: BufferSource): Promise<ArrayBuffer> {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      const out = name === "SHA-1" ? sha1(toBytes(data)) : name === "SHA-256" ? sha256(toBytes(data)) : null;
      if (!out) throw new Error(`crypto shim: unsupported digest ${name}`);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    },
  };
  try {
    Object.defineProperty(globalThis.crypto, "subtle", { value: subtle, configurable: true });
    console.info("[patoli] insecure context: WebCrypto HMAC/SHA shim installed (use https in production)");
  } catch (e) {
    console.warn("[patoli] could not install crypto shim", e);
  }
}
