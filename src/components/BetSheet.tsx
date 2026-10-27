"use client";

import type { MarketKind } from "@/lib/polymarket/gamma";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Info } from "lucide-react";
import Sheet from "./Sheet";
import TicketShare from "./TicketShare";
import type { TicketData } from "./Ticket";
import type { Selection } from "./GameCard";
import { LEAGUE_BY_ID } from "@/lib/polymarket/leagues";
import { breakdown, formatOdds, formatUsd } from "@/lib/polymarket/odds";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { useMe } from "@/providers/MeProvider";
import { usePlaceBet } from "@/hooks/usePlaceBet";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useBuilderFee } from "@/hooks/useBuilderFee";
import { usePrices, useScores } from "@/hooks/useGames";
import { useNow } from "@/hooks/useNow";
import { isLive } from "@/lib/format";
import { SESSION_STEP_LABEL } from "@/lib/polymarket/session";
import { PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";
import { cn } from "@/lib/cn";

const MARKET_NAME: Record<MarketKind, string> = { moneyline: "Ganador", spread: "Hándicap", total: "Total", btts: "Ambos anotan", team_total: "Total por equipo", prop: "Prop de jugador", yesno: "Mercado" };

const ATTRIBUTION_READY = isBuilderCodeValid(PATOLI_BUILDER_CODE);

const QUICK = [5, 10, 25, 50];

export default function BetSheet({ selection, onClose }: { selection: Selection | null; onClose: () => void }) {
  return (
    <Sheet open={!!selection} onClose={onClose} title="Tu apuesta">
      {selection ? <BetBody key={`${selection.market.id}:${selection.outcome.tokenId}`} selection={selection} onClose={onClose} /> : null}
    </Sheet>
  );
}

/** Keyed by selection so stake/result state resets per pick without effects. */
function BetBody({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const router = useRouter();
  const { status, isDemo, email } = useWallet();
  const { me } = useMe();
  const { isReady, step, setupTrading, error } = useTrading();
  const { placeBet, isPlacing } = usePlaceBet();
  const { balance } = useUsdcBalance();
  const { takerBps } = useBuilderFee();
  const [stake, setStake] = useState(10);
  const [done, setDone] = useState<TicketData | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const handle = me?.handle ?? ((email ?? "tú").split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase() || "tú");

  // The sheet keeps quoting while open (2 s in play, 5 s prematch): the price the user confirms is
  // the price on screen at that moment, and the order is capped at exactly that.
  const now = useNow();
  const live = !!now && isLive(selection.game.startTime, now);
  const quote = usePrices([selection.outcome.tokenId], live ? 2_000 : 5_000);
  const scores = useScores(selection.game.league, live);
  const score = scores.data?.[selection.game.slug];
  const price = quote.data?.[selection.outcome.tokenId]?.ask ?? selection.price;
  const b = useMemo(() => breakdown(price, selection.market.fee, takerBps), [price, selection.market.fee, takerBps]);
  // Polymarket spends the full stake on shares and charges the fee ON TOP (that is what leaves the wallet).
  const shares = stake / b.price;
  const polymarketFeeUsd = shares * b.polymarketFee;
  const patoliFeeUsd = shares * b.patoliFee;
  const total = stake + polymarketFeeUsd + patoliFeeUsd;
  const payout = shares;
  const minStake = Math.max(1, selection.market.minOrderSize * price);
  // Dollars really on offer near this price (game page passes it from the order book). Undefined = unknown.
  const available = selection.outcome.depth;
  const thin = available !== undefined && stake > available;

  async function submit() {
    setFail(null);
    if (status !== "connected") {
      router.push("/entrar?next=/deportes");
      return;
    }
    if (!isReady) {
      try {
        await setupTrading();
      } catch (e) {
        setFail(e instanceof Error ? e.message : "No se pudo activar tu cuenta");
      }
      return;
    }
    const res = await placeBet({
      tokenId: selection.outcome.tokenId,
      stake,
      negRisk: selection.market.negRisk,
      tickSize: selection.market.tickSize,
      price,
    });
    if (res.ok) {
      const league = LEAGUE_BY_ID[selection.game.league];
      setDone({
        handle,
        avatar: handle,
        league: league.label,
        leagueEmoji: league.emoji,
        matchup: `${selection.game.home} vs ${selection.game.away}`,
        selection: selection.outcome.label,
        market: selection.market.label ?? MARKET_NAME[selection.market.kind],
        odds: b.netOdds,
        stake: total,
        payout,
        placedAt: new Date().toISOString(),
        status: "open",
        proof: res.txHashes[0] ?? res.orderId,
        kickoff: selection.game.startTime,
      });
    } else {
      if (res.lineMoved) void quote.refetch();
      setFail(res.reason);
    }
  }

  const busy = isPlacing || (step !== "idle" && step !== "complete");
  const cta =
    status !== "connected" ? "Entrar para apostar" : !isReady ? "Activar cuenta (1 vez)" : `Apostar $${formatUsd(stake, 0)}`;

  return (
    <>
      {done ? (
          <div className="pb-2 text-center">
            <div className="flex items-center justify-center gap-2 text-win">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-display text-sm font-extrabold uppercase tracking-wide">Apuesta colocada</span>
            </div>
            <p className="mb-2 mt-1 text-xs text-muted">Tu boleto. Compártelo y que la banda lo vea.</p>
            <TicketShare data={done} onDone={onClose} />
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted">
              {selection.game.title}
              {live ? <span className="pill-live rounded-full px-1.5 py-0.5 font-display text-[9px] font-extrabold">En vivo</span> : null}
              {score ? (
                <span className="tnum normal-case tracking-normal text-ink">
                  {score.first}-{score.second}
                  {score.state !== "post" && score.period ? ` · ${score.period}${score.clock ? ` ${score.clock}` : ""}` : " · Final"}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex items-end justify-between gap-3">
              <div className="font-display text-2xl font-extrabold uppercase leading-none">{selection.outcome.label}</div>
              <div className="tnum font-display text-3xl font-extrabold text-accent-soft">{formatOdds(b.netOdds)}</div>
            </div>

            {/* Price transparency — the whole point */}
            <div className="tnum mt-4 space-y-1.5 rounded-xl bg-surface/60 p-3 text-xs text-muted">
              <Row k="Precio de mercado (Polymarket)" v={formatOdds(b.marketOdds)} />
              <Row k="Comisión Polymarket" v={b.polymarketFee > 0 ? `${formatUsd(polymarketFeeUsd)} (${((b.polymarketFee / b.price) * 100).toFixed(2)}%)` : "$0.00"} />
              <Row k="Comisión Patoli" v={takerBps > 0 ? `${formatUsd(patoliFeeUsd)} (${((b.patoliFee / b.price) * 100).toFixed(2)}%)` : "$0.00 (beta)"} />
              <div className="flex items-center justify-between border-t border-hairline pt-1.5 text-ink">
                <span>Tu precio</span>
                <span className="font-semibold">{formatOdds(b.netOdds)}</span>
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-xs text-muted">
                <span>Monto (USDC)</span>
                {status === "connected" ? <span className="tnum">Saldo ${formatUsd(balance)}</span> : null}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex flex-1 items-center rounded-xl border border-hairline bg-surface px-3">
                  <span className="text-muted">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={minStake}
                    step={1}
                    value={stake}
                    onChange={(e) => setStake(Math.max(0, Number(e.target.value)))}
                    className="tnum w-full bg-transparent py-3 pl-1 text-xl font-semibold outline-none"
                  />
                </div>
                <div className="flex gap-1.5">
                  {QUICK.map((q) => (
                    <button
                      key={q}
                      onClick={() => setStake(q)}
                      className={cn("tnum rounded-lg border px-2.5 py-2 text-xs font-semibold", stake === q ? "border-accent text-accent-soft" : "border-hairline text-muted")}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
              <div className="tnum mt-2 flex items-center justify-between text-sm">
                <span className="text-muted">Si gana cobras</span>
                <span className="font-display text-lg font-extrabold text-win">${formatUsd(payout)}</span>
              </div>
              <div className="tnum mt-1 flex items-center justify-between text-xs text-muted">
                <span>Sale de tu saldo</span>
                <span>${formatUsd(total)}{total > stake ? " · incluye comisiones" : ""}</span>
              </div>
            </div>

            {busy && step !== "idle" ? <p className="pulse-soft mt-3 text-center text-xs text-accent-soft">{SESSION_STEP_LABEL[step]}</p> : null}
            {fail || error ? <p className="mt-3 text-center text-xs text-loss">{fail ?? error?.message}</p> : null}
            {isDemo ? (
              <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Modo demo: falta configurar el login (Magic) y las credenciales de builder para apostar de verdad.
              </p>
            ) : !ATTRIBUTION_READY && status === "connected" ? (
              <p className="mt-3 flex items-start gap-1.5 text-[11px] text-accent-soft">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Falta el código de builder de Patoli. Las apuestas se habilitan en cuanto esté.
              </p>
            ) : null}

            <button
              onClick={submit}
              disabled={
                busy ||
                stake < minStake ||
                thin ||
                (status === "connected" && isReady && (stake > balance || !ATTRIBUTION_READY))
              }
              className="btn-accent mt-4 w-full py-3.5 text-sm"
            >
              {busy ? "Un momento…" : cta}
            </button>
            {thin ? (
              <p className="mt-2 text-center text-xs text-loss">A este precio solo hay ${formatUsd(available ?? 0, 0)} disponibles. Baja el monto o elige otra línea.</p>
            ) : status === "connected" && isReady && stake > balance ? (
              <p className="mt-2 text-center text-xs text-muted">Te falta saldo. Deposita USDC en tu perfil.</p>
            ) : (
              <p className="mt-2 text-center text-[11px] text-muted-2">Prematch · se liquida con las reglas de Polymarket · mínimo ${formatUsd(minStake, 0)}</p>
            )}
          </div>
        )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}
