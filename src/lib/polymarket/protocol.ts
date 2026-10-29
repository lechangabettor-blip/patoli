/**
 * Polymarket protocol versions, decided from data we already hold.
 *
 * CTF ("v1") outcome tokens are ERC-1155 ids on the Conditional Tokens contract, derived by
 * keccak from the condition id — no arithmetic relation between the two.
 *
 * Protocol V2 ("v2") position ids are STRUCTURED: the top 248 bits are the condition identity
 * (what Gamma reports as `conditionId`, a bytes31 left-aligned in bytes32, so it always ends in
 * `00`) and the low 8 bits are the outcome index. Verified live 2026-10-29:
 * `BigInt(conditionId) === BigInt(positionIds[0])` and `positionIds[1] = positionIds[0] + 1`.
 * Hence a market/position is V2 iff `id >> 8 << 8 === conditionId` — a CTF token id satisfies
 * that only by a 2^-248 accident. Gamma also fills `clobTokenIds` on V2 markets with the same
 * numbers, so the field a token came from says nothing; this check does.
 */
export type ProtocolVersion = "v1" | "v2";

const toBig = (hexOrDec: string): bigint | null => {
  try {
    return BigInt(hexOrDec);
  } catch {
    return null;
  }
};

/** True when `id` (token/position id, decimal string) is a Protocol V2 position of `conditionId`. */
export function isV2Position(conditionId: string, id: string): boolean {
  const c = toBig(conditionId);
  const p = toBig(id);
  if (c == null || p == null || c === 0n) return false;
  return ((p >> 8n) << 8n) === c;
}

/** Protocol version of a market from its condition id and any one of its outcome ids. */
export function versionOf(conditionId: string, anyOutcomeId: string | null | undefined): ProtocolVersion {
  return anyOutcomeId && isV2Position(conditionId, anyOutcomeId) ? "v2" : "v1";
}

/** The V2 position id (decimal string) of outcome `index` under `conditionId`. */
export function v2PositionId(conditionId: string, index: number): string {
  return (BigInt(conditionId) + BigInt(index)).toString();
}

/** Outcome index encoded in a V2 position id. */
export function v2OutcomeIndex(positionId: string): number {
  return Number(BigInt(positionId) & 0xffn);
}

/** The bytes31 condition id the V2 Router expects: the 32-byte id without its trailing zero byte. */
export function v2ConditionBytes31(conditionId: string): `0x${string}` {
  const hex = normalizeConditionId(conditionId).slice(2);
  // Polymarket: "for a padded V2 bytes32 value, validate its final byte is zero before narrowing".
  if (!/^[0-9a-f]{64}$/.test(hex) || !hex.endsWith("00")) throw new Error(`No es un condition id de Protocol V2: ${conditionId}`);
  return `0x${hex.slice(0, 62)}`;
}

/**
 * Lowercase `0x` + 64 hex. A Protocol V2 condition id given in its native 31-byte form gets its
 * zero byte back on the RIGHT (bytes32 boundaries right-pad; left-padding would shift the id).
 */
export function normalizeConditionId(id: string): string {
  const hex = id.toLowerCase().replace(/^0x/, "");
  return `0x${hex.length === 62 ? `${hex}00` : hex}`;
}
