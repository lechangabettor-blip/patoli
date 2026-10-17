"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client — READ-ONLY by policy (anon key, RLS public-read
 * tables only). Its single job is Realtime: live updates for Arena matches and
 * rounds. Every write still goes through our API routes (service role).
 */
let client: SupabaseClient | null = null;

export function isRealtimeConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function supabaseBrowser(): SupabaseClient {
  if (!isRealtimeConfigured()) throw new Error("Supabase no está configurado");
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  return client;
}
