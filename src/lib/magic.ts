"use client";

/**
 * Magic lives inside the lazily loaded wallet SDK bundle (see lib/sdk.ts). `getMagic()` returns
 * the instance once that bundle is loaded — which is always the case while a user is logged in.
 */
export { getMagic, isMagicConfigured, loadSdk } from "./sdk";
