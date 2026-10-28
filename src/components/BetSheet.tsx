"use client";

import type { MarketKind } from "@/lib/polymarket/gamma";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Info, Minus, Plus } from "lucide-react";
import Sheet from "./Sheet";
import TicketShare from "./TicketShare";
import LimitBook from "./LimitBook";
import type { TicketData } from "./Ticket";
import type { Selection } from "./GameCard";
import { LEAGUE_BY_ID } from "@/lib/polymarket/leagues";
import { breakdown, formatOdds, formatUsd } from "@/lib/polymarket/odds";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { useMe } from "@/providers/MeProvider";
import { usePlaceBet } from "@/hooks/usePlaceBet";
import { useBook, useCancelOrder, useOpenOrders } from "@/hooks/useOrders";
import { useRecordTail } from "@/hooks/useSocial";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useBuilderFee } from "@/hooks/useBuilderFee";
import { usePrices, useScores } from "@/hooks/useGames";
import { useNow } from "@/hooks/useNow";
import { isLive, kickoffLabel } from "@/lib/format";
import { SESSION_STEP_LABEL } from "@/lib/polymarket/session";
import { PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";
import { cn } from "@/lib/cn";

const MARKET_NAME: Record<MarketKind, string> = { moneyline: "Ganador", spread: "Hándicap", total: "Total", btts: "Ambos anotan", team_total: "Total por equipo", prop: "Prop de jugador", yesno: "Mercado" };

const ATTRIBUTION_READY = isBuilderCodeValid(PATOLI_BUILDER_CODE);

const QUICK = [5, 10, 25, 50];
const QUICK_SHARES = [10, 50, 100];

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
  const { placeBet, placeLimit, isPlacing } = usePlaceBet();
  const recordTail = useRecordTail();
  const { balance } = useUsdcBalance();
  const { takerBps, makerBps } = useBuilderFee();
  const [stake, setStake] = useState(10);
  const [done, setDone] = useState<TicketData | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const handle = me?.handle ?? ((email ?? "tú").split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase() || "tú");

  // Mercado = today's fill-or-kill at the price on screen. Límite = a resting order at the
  // user's price, Polymarket-style: limit price + shares, the app does the money math.
  const [mode, setMode] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState<number | null>(null);
  const [sharesInput, setSharesInput] = useState("");
  const [placed, setPlaced] = useState<{ price: number; shares: number; total: number; odds: number; now: boolean } | null>(null);
  const cancelOrder = useCancelOrder();

  // The sheet keeps quoting while open (2 s in play, 5 s prematch): the price the user confirms is
  // the price on screen at that moment, and the order is capped at exactly that.
  const now = useNow();
  const live = !!now && isLive(selection.game.startTime, now);
  const quote = usePrices([selection.outcome.tokenId], live ? 2_000 : 5_000);
  const scores = useScores(selection.game.league, live);
  const score = scores.data?.[selection.game.slug];
  const marketPrice = quote.data?.[selection.outcome.tokenId]?.ask ?? selection.price;

  // Límite is prematch only: the order expires at kickoff (no resting orders in play).
  const kickoffMs = Date.parse(selection.game.startTime);
  const limitAllowed = !!now && kickoffMs - now.getTime() > 3 * 60_000;
  const isLimit = mode === "limit" && limitAllowed;
  const book = useBook(selection.outcome.tokenId, isLimit);
  const bestAsk = book.data?.asks[0]?.price;
  const bestBid = book.data?.bids[0]?.price;
  const tick = selection.market.tickSize || 0.01;
  const openOrders = useOpenOrders();
  const existing = openOrders.data?.find((o) => o.asset_id === selection.outcome.tokenId && /buy/i.test(o.side));

  // Default limit = the best bid (one cent better than taking the ask is the usual intent).
  const price = isLimit ? (limitPrice ?? bestBid ?? marketPrice) : marketPrice;
  const crosses = isLimit && bestAsk != null && price >= bestAsk - 1e-9;
  const maker = isLimit && !crosses;
  const bps = maker ? makerBps : takerBps;
  const b = useMemo(() => breakdown(price, selection.market.fee, bps, maker), [price, selection.market.fee, bps, maker]);

  // Mercado: the user types dollars and that is what leaves the wallet — fees live inside the odds
  // (shares = stake / all-in cost per share). Límite: the user types shares → cost = shares × price,
  // fees shown as one line on top.
  const limitShares = Math.max(0, Math.floor(Number(sharesInput || 0) * 100) / 100);
  const shares = isLimit ? limitShares : stake / b.costPerShare;
  const cost = isLimit ? limitShares * b.price : shares * b.price;
  const feesUsd = shares * (b.polymarketFee + b.patoliFee);
  const total = cost + feesUsd;
  const payout = shares;
  const minShares = selection.market.minOrderSize || 5;
  const minStake = Math.max(1, minShares * b.costPerShare);
  // "Panthers +3.5" → Panthers / +3.5 · Hándicap · "Más 44.5" → Más / 44.5 · Total · "Ambos anotan · Sí" → Sí / Ambos anotan
  const headline = useMemo(() => {
    const kindName = selection.market.label ?? MARKET_NAME[selection.market.kind];
    const l = selection.outcome.label;
    const sp = l.match(/^(.*?)\s([+-][\d.]+)$/);
    const ou = l.match(/^(Más|Menos)\s([\d.]+)$/);
    if (selection.market.kind === "spread" && sp) return { title: sp[1], sub: `${sp[2]} · ${kindName}` };
    if (ou) return { title: ou[1], sub: `${ou[2]} · ${kindName}` };
    if (l.includes(" · ")) return { title: l.split(" · ").slice(-1)[0], sub: l.split(" · ").slice(0, -1).join(" · ") };
    return { title: l, sub: kindName };
  }, [selection]);
  // Dollars really on offer near this price (game page passes it from the order book). Undefined = unknown.
  const available = selection.outcome.depth;
  const thin = !isLimit && available !== undefined && stake > available;
  const limitInvalid = isLimit && (limitShares < minShares || price < tick || price > 1 - tick);

  const stepPrice = (dir: 1 | -1) => {
    const next = Math.round((price + dir * tick) / tick) * tick;
    setLimitPrice(Math.min(1 - tick, Math.max(tick, Number(next.toFixed(4)))));
  };

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
    if (isLimit) {
      const lim = await placeLimit({
        tokenId: selection.outcome.tokenId,
        price,
        shares: limitShares,
        negRisk: selection.market.negRisk,
        tickSize: tick,
        expiresAt: Math.floor(kickoffMs / 1000),
      });
      if (!lim.ok) {
        setFail(lim.reason);
        return;
      }
      if (lim.matched && selection.source) void recordTail(selection.source.betId, selection.source.side);
      setPlaced({ price, shares: limitShares, total, odds: b.netOdds, now: lim.matched });
      return;
    }
    const res = await placeBet({
      tokenId: selection.outcome.tokenId,
      stake: Math.floor(cost * 100) / 100, // dollars that go to shares; Polymarket adds the fees → ≈ stake leaves
      negRisk: selection.market.negRisk,
      tickSize: tick,
      price,
    });
    if (res.ok) {
      // Súbaseee/Bájeseee: the server counts it once it sees this fill indexed under our profile.
      if (selection.source) void recordTail(selection.source.betId, selection.source.side);
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
        stake,
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
  const cents = Math.round(price * 100);
  const cta =
    status !== "connected"
      ? "Entrar para apostar"
      : !isReady
        ? "Activar cuenta (1 vez)"
        : isLimit
          ? crosses
            ? `Comprar a ${cents}¢`
            : `Poner orden a ${cents}¢`
          : `Apostar $${formatUsd(stake, 0)}`;
  const disabled =
    busy ||
    thin ||
    (isLimit ? limitInvalid : stake < minStake) ||
    (status === "connected" && isReady && ((isLimit ? total : stake) > balance || !ATTRIBUTION_READY));

  return (
    <>
      {placed ? (
        <div className="py-4 text-center">
          <div className="flex items-center justify-center gap-2 text-win">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-display text-sm font-extrabold uppercase tracking-wide">{placed.now ? "Orden llenada" : "Orden puesta"}</span>
          </div>
          <div className="mt-3 font-display text-2xl font-extrabold uppercase leading-none">{selection.outcome.label}</div>
          <div className="tnum mt-1 text-sm text-muted">
            {Math.round(placed.price * 100)}¢ · {formatOdds(placed.odds)} · {formatUsd(placed.shares, 0)} shares · ${formatUsd(placed.total)}
          </div>
          <p className="mt-3 text-xs text-muted">
            {placed.now
              ? "Se llenó al instante. Ya aparece en tus apuestas abiertas."
              : "Espera en el libro de Polymarket. Si nadie vende a ese precio, se cancela sola al inicio del partido. La ves y la cancelas en Perfil → Órdenes límite."}
          </p>
          <button onClick={onClose} className="btn-accent mt-5 w-full py-3 text-sm">
            Listo
          </button>
        </div>
      ) : done ? (
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
            <span className="truncate">{selection.game.title}</span>
            {live ? <span className="pill-live shrink-0 rounded-full px-1.5 py-0.5 font-display text-[9px] font-extrabold">En vivo</span> : null}
            {score ? (
              <span className="tnum shrink-0 normal-case tracking-normal text-ink">
                {score.first}-{score.second}
                {score.state !== "post" && score.period ? ` · ${score.period}${score.clock ? ` ${score.clock}` : ""}` : " · Final"}
              </span>
            ) : null}
            {limitAllowed ? (
              <div className="ml-auto flex shrink-0 rounded-full bg-surface p-0.5 normal-case tracking-normal">
                {(["market", "limit"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m);
                      setFail(null);
                    }}
                    className={cn("rounded-full px-2.5 py-1 font-display text-[10px] font-extrabold uppercase tracking-wide transition-colors", mode === m ? "bg-accent text-white" : "text-muted")}
                  >
                    {m === "market" ? "Mercado" : "Límite"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-display text-2xl font-extrabold uppercase leading-none">{headline.title}</div>
              <div className="tnum mt-1 truncate text-sm text-muted">{headline.sub}</div>
            </div>
            <div className="tnum shrink-0 font-display text-3xl font-extrabold text-accent-soft">{formatOdds(b.netOdds)}</div>
          </div>
          {selection.source ? (
            <p className="mt-1.5 text-xs text-muted">
              {selection.source.side === "tail" ? "Te subes al pick de" : "Vas contra el pick de"} <span className="text-ink">@{selection.source.handle}</span>
            </p>
          ) : null}

          {isLimit ? (
            <>
              {/* Top of the book: tap a row to take that price */}
              <LimitBook book={book.data} selected={price} onSelect={setLimitPrice} fee={selection.market.fee} takerBps={takerBps} makerBps={makerBps} loading={book.isLoading} />

              {/* Limit price */}
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Precio límite</div>
                  <div className="tnum text-xs text-muted">{crosses ? "Se llena ahora" : "Espera en el libro"} · cuota {formatOdds(b.netOdds)}</div>
                </div>
                <div className="flex items-center rounded-xl border border-hairline bg-surface">
                  <button onClick={() => stepPrice(-1)} aria-label="Un centavo menos" className="px-3 py-3 text-muted active:text-ink">
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="tnum w-14 text-center font-display text-xl font-extrabold">{cents}¢</span>
                  <button onClick={() => stepPrice(1)} aria-label="Un centavo más" className="px-3 py-3 text-muted active:text-ink">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Shares */}
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Shares</div>
                  <div className="tnum text-xs text-muted">${formatUsd(balance)} disponibles · mínimo {minShares}</div>
                </div>
                <div className="flex items-center rounded-xl border border-hairline bg-surface px-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={minShares}
                    step={1}
                    placeholder="0"
                    value={sharesInput}
                    onChange={(e) => setSharesInput(e.target.value.replace(/[^0-9.]/g, ""))}
                    className="tnum w-24 bg-transparent py-3 text-right text-xl font-semibold outline-none"
                  />
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                {QUICK_SHARES.map((q) => (
                  <button key={q} onClick={() => setSharesInput(String(limitShares + q))} className="tnum rounded-lg border border-hairline px-2.5 py-1.5 text-xs font-semibold text-muted">
                    +{q}
                  </button>
                ))}
                {limitShares > 0 ? (
                  <button onClick={() => setSharesInput("")} className="rounded-lg border border-hairline px-2.5 py-1.5 text-xs font-semibold text-muted">
                    Borrar
                  </button>
                ) : null}
              </div>

              {existing ? (
                <p className="tnum mt-3 flex items-center justify-between rounded-xl bg-surface/60 px-3 py-2 text-xs text-muted">
                  <span>
                    Ya tienes una orden a {Math.round(Number(existing.price) * 100)}¢ por ${formatUsd(Number(existing.original_size) * Number(existing.price), 0)}
                  </span>
                  <button onClick={() => void cancelOrder(existing.id)} className="font-display text-[11px] font-bold uppercase text-accent-soft">
                    Cancelar
                  </button>
                </p>
              ) : null}

              {/* The money */}
              <div className="tnum mt-4 space-y-1.5 rounded-xl bg-surface/60 p-3 text-xs text-muted">
                <Row k={`${formatUsd(limitShares, 0)} shares × ${cents}¢`} v={`${formatUsd(cost)}`} />
                <Row k="Comisión" v={`${formatUsd(feesUsd)}`} />
                <div className="flex items-center justify-between border-t border-hairline pt-1.5 text-sm text-ink">
                  <span>Apuestas</span>
                  <span className="font-display text-base font-extrabold">${formatUsd(total)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink">Si gana cobras</span>
                  <span className="font-display text-lg font-extrabold text-win">${formatUsd(payout)}</span>
                </div>
                <Row k="Expira" v={`al inicio · ${kickoffLabel(selection.game.startTime, now)}`} />
              </div>
            </>
          ) : (
            <>
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
              </div>
            </>
          )}

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

          <button onClick={submit} disabled={disabled} className="btn-accent mt-4 w-full py-3.5 text-sm">
            {busy ? "Un momento…" : cta}
          </button>
          {thin ? (
            <p className="mt-2 text-center text-xs text-loss">A este precio solo hay ${formatUsd(available ?? 0, 0)} disponibles. Baja el monto o elige otra línea.</p>
          ) : status === "connected" && isReady && (isLimit ? total : stake) > balance ? (
            <p className="mt-2 text-center text-xs text-muted">Te falta saldo. Deposita USDC en tu perfil.</p>
          ) : isLimit ? (
            <p className="mt-2 text-center text-[11px] text-muted-2">Orden límite · se cancela sola al inicio del partido · mínimo {minShares} shares</p>
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
