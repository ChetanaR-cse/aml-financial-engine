"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  Database,
  DollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  ArrowRight,
  Gauge,
  GitBranch,
  Loader2,
  Lock,
  Zap,
  Network,
  Radar,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

/* ========================= LOGIC START (pure, testable) ========================= */

type Pt = { x: number; y: number };
type Txn = { from: string; to: string; amount: number; t: number };
type Edge = {
  from: string;
  to: string;
  amount: number;
  count: number;
  first: number;
  last: number;
  max: number;
  min: number;
};
type Params = { windowH: number; minSize: number };
type Ring = {
  id: string;
  accounts: string[]; // ordered along the flow of funds
  volume: number;
  txCount: number;
  hours: number;
  risk: number;
  typology: string;
  firstTs: number;
  lastTs: number;
  maxTransfer: number;
  minTransfer: number;
};
type ViewNode = { id: string; x: number; y: number; ring: number };
type ViewLink = { a: string; b: string; ring: number };
type Analysis = {
  txCount: number;
  accountCount: number;
  totalVolume: number;
  rings: Ring[]; // all detected rings, sorted by risk
  nodes: ViewNode[]; // nodes drawn on the canvas
  links: ViewLink[];
  shown: number; // how many rings are drawn (first N of rings)
  flaggedVolume: number;
  riskIndex: number;
  riskLabel: string;
  ms: number;
};

const CANVAS_W = 800;
const CANVAS_H = 480;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function usd(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function usdShort(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return usd(n);
}

function fmtDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/* ----------------------------- CSV parsing ----------------------------- */

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const FROM_KEYS = ["sender", "from", "source", "origin", "src", "payer", "originator", "from_account", "source_account", "sender_id", "sender_account"];
const TO_KEYS = ["receiver", "to", "target", "dest", "destination", "beneficiary", "payee", "to_account", "target_account", "receiver_id", "receiver_account"];
const AMT_KEYS = ["amount", "amt", "value", "usd", "amount_usd", "transaction_amount"];
const TIME_KEYS = ["timestamp", "time", "date", "datetime", "created_at", "txn_date", "transaction_date"];

function parseCSV(text: string): { rows: Txn[]; hasTime: boolean; error?: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], hasTime: false, error: "The file needs a header row and at least one transaction." };
  if (lines.length > 300_001) return { rows: [], hasTime: false, error: "File too large for in-browser analysis (limit 300,000 rows)." };

  const header = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const find = (keys: string[]) => header.findIndex((h) => keys.includes(h));
  const iFrom = find(FROM_KEYS);
  const iTo = find(TO_KEYS);
  const iAmt = find(AMT_KEYS);
  const iTime = find(TIME_KEYS);
  if (iFrom < 0 || iTo < 0 || iAmt < 0) {
    return {
      rows: [],
      hasTime: false,
      error: "Could not find required columns. Expected: sender, receiver, amount (and optionally timestamp).",
    };
  }

  const rows: Txn[] = [];
  let timeOk = iTime >= 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i]);
    const from = c[iFrom];
    const to = c[iTo];
    const amount = parseFloat((c[iAmt] ?? "").replace(/[$,\s]/g, ""));
    if (!from || !to || from === to || !isFinite(amount) || amount <= 0) continue;
    let t = iTime >= 0 ? Date.parse(c[iTime] ?? "") : NaN;
    if (isNaN(t)) {
      timeOk = false;
      t = i * 3_600_000; // fall back to row order, 1 hour apart
    }
    rows.push({ from, to, amount, t });
  }
  if (rows.length === 0) return { rows: [], hasTime: false, error: "No valid transactions found (check amounts and account columns)." };
  return { rows, hasTime: timeOk, error: undefined };
}

/* ------------------------- Cycle (ring) detection ------------------------- */

// Tarjan's strongly connected components. Any SCC with 3+ accounts means
// money can flow out of an account and eventually come back to it.
function tarjan(adj: Map<string, string[]>): string[][] {
  let idx = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];

  const strong = (v: string) => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp);
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) strong(v);
  return out;
}

function typologyOf(n: number, hours: number) {
  if (hours <= 48) return "Rapid circular layering";
  if (n >= 5) return "Multi-hop layering loop";
  return "Round-tripping cycle";
}

function analyze(txns: Txn[], p: Params): Analysis {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const adj = new Map<string, string[]>();
  const edges = new Map<string, Edge>();
  let totalVolume = 0;

  for (const x of txns) {
    totalVolume += x.amount;
    if (!adj.has(x.from)) adj.set(x.from, []);
    if (!adj.has(x.to)) adj.set(x.to, []);
    const k = x.from + "\u0001" + x.to;
    const e = edges.get(k);
    if (e) {
      e.amount += x.amount;
      e.count++;
      e.first = Math.min(e.first, x.t);
      e.last = Math.max(e.last, x.t);
      e.max = Math.max(e.max, x.amount);
      e.min = Math.min(e.min, x.amount);
    } else {
      edges.set(k, { from: x.from, to: x.to, amount: x.amount, count: 1, first: x.t, last: x.t, max: x.amount, min: x.amount });
      adj.get(x.from)!.push(x.to);
    }
  }

  // 1) find candidate rings
  const rawRings: { ring: Ring; order: string[]; set: Set<string> }[] = [];
  for (const comp of tarjan(adj)) {
    if (comp.length < p.minSize || comp.length > 12) continue;
    const set = new Set(comp);
    const inner: Edge[] = [];
    for (const e of edges.values()) if (set.has(e.from) && set.has(e.to)) inner.push(e);
    if (inner.length < comp.length) continue;

    const firstTs = Math.min(...inner.map((e) => e.first));
    const lastTs = Math.max(...inner.map((e) => e.last));
    const hours = (lastTs - firstTs) / 3_600_000;
    if (hours > p.windowH) continue; // too slow to be layering within the chosen window

    const volume = inner.reduce((s, e) => s + e.amount, 0);
    const txCount = inner.reduce((s, e) => s + e.count, 0);
    const avgs = inner.map((e) => e.amount / e.count);
    const mean = avgs.reduce((s, v) => s + v, 0) / avgs.length;
    const sd = Math.sqrt(avgs.reduce((s, v) => s + (v - mean) ** 2, 0) / avgs.length);
    const similarity = Math.max(0, 1 - sd / mean);
    const speed = hours <= 48 ? 1 : hours <= 96 ? 0.75 : hours <= 168 ? 0.5 : 0.25;
    const risk = Math.round(
      Math.min(99, 50 + 18 * speed + 14 * Math.min(1, volume / 1_000_000) + 10 * similarity + Math.min(7, comp.length))
    );

    // order accounts along the flow so the loop is drawn in sequence
    const order = [comp[0]];
    const seen = new Set(order);
    let cur = comp[0];
    while (order.length < comp.length) {
      const next = (adj.get(cur) ?? []).find((w) => set.has(w) && !seen.has(w)) ?? comp.find((w) => !seen.has(w))!;
      order.push(next);
      seen.add(next);
      cur = next;
    }

    rawRings.push({
      order,
      set,
      ring: {
        id: "",
        accounts: order,
        volume,
        txCount,
        hours,
        risk,
        typology: typologyOf(comp.length, hours),
        firstTs,
        lastTs,
        maxTransfer: Math.max(...inner.map((e) => e.max)),
        minTransfer: Math.min(...inner.map((e) => e.min)),
      },
    });
  }
  rawRings.sort((a, b) => b.ring.risk - a.ring.risk || b.ring.volume - a.ring.volume);
  rawRings.forEach((r, i) => (r.ring.id = `RING-${String(i + 1).padStart(3, "0")}`));
  const rings = rawRings.map((r) => r.ring);

  // 2) choose and lay out the nodes to draw
  const shown = Math.min(6, rawRings.length);
  const pos = new Map<string, Pt>();
  const ringOf = new Map<string, number>();
  const centers: { c: Pt; r: number }[] = [];
  if (shown > 0) {
    const cols = Math.min(shown, 3);
    const rowsN = Math.ceil(shown / cols);
    const cw = CANVAS_W / cols;
    const ch = CANVAS_H / rowsN;
    for (let i = 0; i < shown; i++) {
      const n = rawRings[i].order.length;
      const c = { x: ((i % cols) + 0.5) * cw, y: (Math.floor(i / cols) + 0.5) * ch };
      const maxR = Math.min(cw, ch) / 2 - 45;
      const r = Math.max(28, Math.min(26 + n * 9, maxR));
      centers.push({ c, r });
      rawRings[i].order.forEach((id, j) => {
        const th = -Math.PI / 2 + (2 * Math.PI * j) / n;
        pos.set(id, { x: c.x + r * Math.cos(th), y: c.y + r * Math.sin(th) });
        ringOf.set(id, i);
      });
    }
  }

  const nodeVol = new Map<string, number>();
  const nearScore = new Map<string, number>();
  for (const e of edges.values()) {
    nodeVol.set(e.from, (nodeVol.get(e.from) ?? 0) + e.amount);
    nodeVol.set(e.to, (nodeVol.get(e.to) ?? 0) + e.amount);
    const fa = ringOf.has(e.from);
    const fb = ringOf.has(e.to);
    if (fa && !fb) nearScore.set(e.to, (nearScore.get(e.to) ?? 0) + e.amount);
    if (fb && !fa) nearScore.set(e.from, (nearScore.get(e.from) ?? 0) + e.amount);
  }
  const free: string[] = [];
  const pick = (ids: string[], cap: number) => {
    for (const id of ids) {
      if (free.length >= cap) break;
      if (!ringOf.has(id) && !free.includes(id)) free.push(id);
    }
  };
  pick([...nearScore.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]), 16);
  pick([...nodeVol.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]), 26);

  const rnd = mulberry32(42);
  for (const id of free) pos.set(id, { x: 40 + rnd() * (CANVAS_W - 80), y: 40 + rnd() * (CANVAS_H - 80) });

  const links: ViewLink[] = [];
  for (const e of edges.values()) {
    if (!pos.has(e.from) || !pos.has(e.to)) continue;
    const ra = ringOf.get(e.from);
    const rb = ringOf.get(e.to);
    links.push({ a: e.from, b: e.to, ring: ra !== undefined && ra === rb ? ra : -1 });
    if (links.length >= 500) break;
  }

  const freeSet = new Set(free);
  for (let it = 0; it < 90; it++) {
    for (const id of free) {
      const p0 = pos.get(id)!;
      let fx = 0;
      let fy = 0;
      for (const [oid, q] of pos) {
        if (oid === id) continue;
        const dx = p0.x - q.x;
        const dy = p0.y - q.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.5;
        const rep = 600 / d;
        fx += (dx / d) * rep;
        fy += (dy / d) * rep;
      }
      for (const l of links) {
        if (l.a !== id && l.b !== id) continue;
        const o = pos.get(l.a === id ? l.b : l.a)!;
        const dx = o.x - p0.x;
        const dy = o.y - p0.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.5;
        const sp = 0.04 * (d - 90);
        fx += (dx / d) * sp;
        fy += (dy / d) * sp;
      }
      for (const { c, r } of centers) {
        const dx = p0.x - c.x;
        const dy = p0.y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.5;
        if (d < r + 50) {
          const push = (r + 50 - d) * 0.6;
          fx += (dx / d) * push;
          fy += (dy / d) * push;
        }
      }
      const mag = Math.sqrt(fx * fx + fy * fy);
      const k = mag > 12 ? 12 / mag : 1;
      p0.x = Math.min(CANVAS_W - 28, Math.max(28, p0.x + fx * k * 0.6));
      p0.y = Math.min(CANVAS_H - 28, Math.max(28, p0.y + fy * k * 0.6));
    }
  }

  const nodes: ViewNode[] = [];
  for (const [id, p0] of pos) nodes.push({ id, x: p0.x, y: p0.y, ring: freeSet.has(id) ? -1 : ringOf.get(id) ?? -1 });

  const flaggedVolume = rings.reduce((s, r) => s + r.volume, 0);
  const maxRisk = rings.reduce((m, r) => Math.max(m, r.risk), 0);
  const share = totalVolume > 0 ? flaggedVolume / totalVolume : 0;
  const riskIndex = rings.length ? Math.min(99, Math.round(0.7 * maxRisk + 30 * Math.min(1, share * 5))) : 8;
  const riskLabel = riskIndex >= 80 ? "Critical" : riskIndex >= 60 ? "High" : riskIndex >= 35 ? "Medium" : "Low";

  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    txCount: txns.length,
    accountCount: adj.size,
    totalVolume,
    rings,
    nodes,
    links,
    shown,
    flaggedVolume,
    riskIndex,
    riskLabel,
    ms: Math.max(1, Math.round(now - started)),
  };
}

/* ------------------------------ SAR narrative ------------------------------ */

function buildNarrative(r: Ring, hasTime: boolean): string {
  const n = r.accounts.length;
  const list =
    r.accounts.slice(0, 6).join(", ") + (n > 6 ? ` and ${n - 6} other accounts` : "");
  const period = hasTime ? ` between ${fmtDate(r.firstTs)} and ${fmtDate(r.lastTs)} UTC` : "";
  const hrs = r.hours < 1 ? "under one hour" : `${Math.round(r.hours)} hours`;
  return [
    `SUBJECT & ACTIVITY SUMMARY\nAcross ${r.txCount} transactions${period}, ${n} linked accounts (${list}) moved ${usd(
      r.volume
    )} in a closed circular pattern (cluster ${r.id}). Funds left an originating account, passed through ${
      n - 1
    } intermediary accounts, and returned to the originator within ${hrs}, with no identifiable goods, services or lawful business purpose.`,
    `WHY THIS PATTERN IS SUSPICIOUS\nA legitimate payment moves value to a counterparty in exchange for something. Here, the same value circulates between related parties and ends where it began. This is the hallmark of layering: the stage of money laundering in which illicit proceeds are moved repeatedly to obscure their origin and break the audit trail. Individual transfers ranged from ${usd(
      r.minTransfer
    )} to ${usd(
      r.maxTransfer
    )}, were closely sized, and occurred in rapid succession, which is consistent with deliberate structuring rather than ordinary commerce.`,
    `POTENTIAL LEGAL EXPOSURE\nThe activity is consistent with conduct prohibited by the money laundering statute, 18 U.S.C. § 1956, which criminalizes conducting financial transactions to conceal the nature, source or ownership of criminal proceeds. Patterns designed to avoid reporting thresholds may also implicate 31 U.S.C. § 5324 (structuring). Failure to report such activity may breach the institution's obligations under the Bank Secrecy Act.`,
    `RECOMMENDED ACTION\nFile a Suspicious Activity Report, apply enhanced due diligence to all ${n} accounts, preserve transaction records, and escalate to the BSA/AML Officer to review account restrictions. Do not notify the account holders.`,
    `Note: This narrative was drafted by Aegis AI from graph analysis (risk score ${r.risk}/100). It is not a legal conclusion and must be reviewed and approved by a qualified compliance officer before filing.`,
  ].join("\n\n");
}

/* ------------------------------- Demo dataset ------------------------------ */

function makeDemoCSV(): string {
  const rnd = mulberry32(7);
  const base = Date.UTC(2026, 9, 1);
  const H = 3_600_000;
  const rows: [string, string, number, number][] = [];

  // Background activity: money only flows "forward" between ordinary accounts (no cycles)
  for (let i = 0; i < 900; i++) {
    const a = Math.floor(rnd() * 139);
    const b = a + 1 + Math.floor(rnd() * (139 - a));
    const amt = Math.round((50 + rnd() * rnd() * 9000) * 100) / 100;
    rows.push([`ACC-${1000 + a}`, `ACC-${1000 + b}`, amt, base + rnd() * 28 * 24 * H]);
  }

  // Laundering rings: funds loop back to the originator, skimming ~1.5% per hop
  const rings = [
    { ids: [9101, 9102, 9103, 9104, 9105], amt: 462_000, hop: 13, start: 12 * 24 + 3, entry: 1010, exit: 1130 },
    { ids: [9201, 9202, 9203, 9204], amt: 285_000, hop: 11, start: 17 * 24 + 8, entry: 1022, exit: 1121 },
    { ids: [9301, 9302, 9303], amt: 262_000, hop: 10, start: 21 * 24 + 15, entry: 1040, exit: 1100 },
  ];
  for (const r of rings) {
    const n = r.ids.length;
    rows.push([`ACC-${r.entry}`, `ACC-${r.ids[0]}`, r.amt * 1.02, base + (r.start - 6) * H]);
    for (let j = 0; j < n; j++) {
      const from = r.ids[j];
      const to = r.ids[(j + 1) % n];
      rows.push([`ACC-${from}`, `ACC-${to}`, Math.round(r.amt * (1 - 0.015 * j)), base + (r.start + j * r.hop) * H]);
    }
    rows.push([`ACC-${r.ids[2 % n]}`, `ACC-${r.exit}`, r.amt * 0.05, base + (r.start + n * r.hop + 4) * H]);
  }

  // Decoys: a two-account refund pair (too small) and a slow 3-cycle (outside a 7-day window)
  rows.push(["ACC-2001", "ACC-2002", 340, base + 5 * 24 * H], ["ACC-2002", "ACC-2001", 340, base + 6 * 24 * H]);
  rows.push(["ACC-3001", "ACC-3002", 1200, base + 2 * 24 * H], ["ACC-3002", "ACC-3003", 1200, base + 12 * 24 * H], ["ACC-3003", "ACC-3001", 1200, base + 22 * 24 * H]);

  rows.sort((a, b) => a[3] - b[3]);
  const lines = ["sender,receiver,amount,timestamp"];
  for (const [f, t, a, ts] of rows) lines.push(`${f},${t},${Math.round(a * 100) / 100},${new Date(ts).toISOString()}`);
  return lines.join("\n");
}

/* ========================== LOGIC END (pure, testable) ========================== */

const STAGES = [
  "Parsing transactions",
  "Building account graph",
  "Detecting cyclic flows",
  "Scoring risk & drafting evidence",
];
const WINDOWS = [
  { h: 24, label: "24 hours" },
  { h: 72, label: "72 hours" },
  { h: 168, label: "7 days" },
  { h: 720, label: "30 days" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------ Landing visuals ------------------------------ */

const HERO_RING = Array.from({ length: 5 }, (_, j) => {
  const th = -Math.PI / 2 + (2 * Math.PI * j) / 5;
  return { x: +(300 + 88 * Math.cos(th)).toFixed(1), y: +(205 + 88 * Math.sin(th)).toFixed(1) };
});
const HERO_SAFE: Pt[] = [
  { x: 70, y: 70 }, { x: 150, y: 150 }, { x: 60, y: 250 }, { x: 170, y: 330 }, { x: 300, y: 60 },
  { x: 455, y: 90 }, { x: 470, y: 215 }, { x: 440, y: 335 }, { x: 310, y: 375 }, { x: 230, y: 30 },
];
const HERO_LINKS: [number, number][] = [[0, 1], [1, 2], [2, 3], [4, 9], [5, 6], [6, 7], [7, 8], [3, 8]];
const HERO_BRIDGES: [number, number][] = [[1, 4], [4, 0], [5, 1], [6, 2], [8, 3], [3, 3]];

function HeroGraph({ animate }: { animate: boolean }) {
  return (
    <div className="relative">
      <div className="absolute -inset-6 rounded-[2rem] bg-[radial-gradient(circle_at_50%_40%,rgba(244,63,94,0.18),transparent_60%),radial-gradient(circle_at_20%_80%,rgba(16,185,129,0.15),transparent_55%)] blur-xl" />
      <div className="relative overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-950/80 shadow-[0_0_60px_rgba(2,6,23,0.8)] backdrop-blur">
        <div className="flex items-center gap-1.5 border-b border-slate-800 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-3 text-xs text-slate-500">aegis · live topology preview</span>
        </div>
        <div className="bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:28px_28px]">
          <svg viewBox="0 0 520 420" className="block h-auto w-full" role="img" aria-label="Illustration of a laundering ring hidden inside a transaction network">
            <defs>
              <marker id="hero-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="#fb7185" />
              </marker>
              <filter id="hero-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <linearGradient id="hero-scan" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#34d399" stopOpacity="0" />
                <stop offset="1" stopColor="#34d399" stopOpacity="0.35" />
              </linearGradient>
            </defs>
            {HERO_LINKS.map(([a, b], i) => (
              <line key={`l${i}`} x1={HERO_SAFE[a].x} y1={HERO_SAFE[a].y} x2={HERO_SAFE[b].x} y2={HERO_SAFE[b].y} stroke="#34d399" strokeOpacity={0.25} strokeWidth={1.5} />
            ))}
            {HERO_BRIDGES.map(([s, r], i) => (
              <line key={`b${i}`} x1={HERO_SAFE[s].x} y1={HERO_SAFE[s].y} x2={HERO_RING[r].x} y2={HERO_RING[r].y} stroke="#94a3b8" strokeOpacity={0.35} strokeDasharray="4 5" />
            ))}
            {HERO_RING.map((p, j) => {
              const q = HERO_RING[(j + 1) % 5];
              const dx = q.x - p.x;
              const dy = q.y - p.y;
              const len = Math.hypot(dx, dy);
              const ux = dx / len;
              const uy = dy / len;
              return (
                <line key={`r${j}`} x1={p.x + ux * 13} y1={p.y + uy * 13} x2={q.x - ux * 17} y2={q.y - uy * 17} stroke="#fb7185" strokeWidth={2.5} strokeDasharray="6 4" markerEnd="url(#hero-arrow)" filter="url(#hero-glow)">
                  {animate && <animate attributeName="stroke-dashoffset" from="20" to="0" dur="1.2s" repeatCount="indefinite" />}
                </line>
              );
            })}
            {HERO_SAFE.map((p, i) => (
              <circle key={`s${i}`} cx={p.x} cy={p.y} r={7} fill="#10b981" stroke="#a7f3d0" strokeWidth={1.2} filter="url(#hero-glow)">
                {animate && <animate attributeName="opacity" values="1;0.55;1" dur={`${3 + (i % 4)}s`} repeatCount="indefinite" />}
              </circle>
            ))}
            {HERO_RING.map((p, j) => (
              <g key={`rn${j}`}>
                {animate && (
                  <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="#f43f5e" strokeOpacity={0.5}>
                    <animate attributeName="r" values="12;24;12" dur="2.4s" begin={`${j * 0.25}s`} repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.6;0;0.6" dur="2.4s" begin={`${j * 0.25}s`} repeatCount="indefinite" />
                  </circle>
                )}
                <circle cx={p.x} cy={p.y} r={10} fill="#f43f5e" stroke="#fecdd3" strokeWidth={1.5} filter="url(#hero-glow)" />
              </g>
            ))}
            <text x="300" y="209" textAnchor="middle" className="fill-rose-200 text-[12px] font-semibold">RING-001</text>
            {animate && (
              <rect x="0" y="0" width="520" height="46" fill="url(#hero-scan)">
                <animate attributeName="y" values="-46;420" dur="4.5s" repeatCount="indefinite" />
              </rect>
            )}
          </svg>
        </div>
      </div>

      <div className="absolute -left-3 top-16 hidden items-center gap-2 rounded-full border border-emerald-400/30 bg-slate-950/90 px-3 py-1.5 text-xs text-emerald-200 shadow-[0_0_20px_rgba(16,185,129,0.25)] sm:flex">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        Scanning transaction graph…
      </div>
      <div className="absolute -bottom-4 right-2 rounded-xl border border-rose-400/40 bg-slate-950/95 px-4 py-3 shadow-[0_0_30px_rgba(244,63,94,0.3)] sm:right-6">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5" /> Laundering ring detected
        </p>
        <p className="mt-1 text-xs text-slate-400">Circular layering loop · 5 accounts</p>
        <p className="mt-1 text-sm font-semibold tabular-nums text-white">Risk 94/100 · $2.3M</p>
      </div>
    </div>
  );
}

function MiniRing({ n }: { n: number }) {
  const pts = Array.from({ length: n }, (_, j) => {
    const th = -Math.PI / 2 + (2 * Math.PI * j) / n;
    return { x: +(60 + 26 * Math.cos(th)).toFixed(1), y: +(40 + 26 * Math.sin(th)).toFixed(1) };
  });
  return (
    <svg viewBox="0 0 120 80" className="h-20 w-32" aria-hidden>
      <defs>
        <marker id={`mini-${n}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#fb7185" />
        </marker>
      </defs>
      {pts.map((p, j) => {
        const q = pts[(j + 1) % n];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len = Math.hypot(dx, dy);
        const ux = dx / len;
        const uy = dy / len;
        return <line key={j} x1={p.x + ux * 6} y1={p.y + uy * 6} x2={q.x - ux * 9} y2={q.y - uy * 9} stroke="#fb7185" strokeWidth={1.6} markerEnd={`url(#mini-${n})`} />;
      })}
      {pts.map((p, j) => (
        <circle key={j} cx={p.x} cy={p.y} r={5} fill="#f43f5e" stroke="#fecdd3" strokeWidth={1} />
      ))}
    </svg>
  );
}

function PipelineStrip({ stage }: { stage: number }) {
  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-4" aria-live="polite">
      {STAGES.map((s, i) => (
        <li
          key={s}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition ${
            i < stage
              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
              : i === stage
              ? "border-emerald-400/60 bg-emerald-500/15 text-white shadow-[0_0_16px_rgba(16,185,129,0.25)]"
              : "border-slate-800 bg-slate-900 text-slate-500"
          }`}
        >
          {i < stage ? (
            <Check className="h-3.5 w-3.5 shrink-0" />
          ) : i === stage ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-slate-700" />
          )}
          {s}
        </li>
      ))}
    </ol>
  );
}

const HOW_STEPS = [
  { Icon: Upload, title: "Upload", text: "Drop in a transactions CSV: sender, receiver, amount, timestamp.", tone: "text-sky-300 bg-sky-500/10 ring-sky-400/30" },
  { Icon: GitBranch, title: "Build the graph", text: "Every account becomes a node and every payment a directed edge.", tone: "text-emerald-300 bg-emerald-500/10 ring-emerald-400/30" },
  { Icon: Radar, title: "Detect rings", text: "Tarjan's algorithm finds loops where money returns to its source.", tone: "text-rose-300 bg-rose-500/10 ring-rose-400/30" },
  { Icon: FileText, title: "Draft the SAR", text: "Each ring gets a risk score and a plain-language legal narrative.", tone: "text-amber-300 bg-amber-500/10 ring-amber-400/30" },
];

const TYPOLOGIES = [
  { n: 5, title: "Circular layering", text: "Funds hop through several accounts and land back at the originator, hiding the trail." },
  { n: 4, title: "Rapid pass-through", text: "Accounts that receive and forward nearly the same amount within hours." },
  { n: 3, title: "Round-tripping", text: "A small group trades the same value back and forth to look like real business." },
];

function Landing(props: {
  busy: boolean;
  stage: number;
  error: string;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  onFile: (f?: File | null) => void;
  onBrowse: () => void;
  onDemo: () => void;
  onSample: () => void;
  reduceMotion: boolean;
}) {
  const { busy, stage, error, dragging, setDragging, onFile, onBrowse, onDemo, onSample, reduceMotion } = props;
  return (
    <div className="mt-8 space-y-16 pb-4">
      {/* Hero */}
      <section className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <Zap className="h-3.5 w-3.5" /> PS 2.1 · Graph-based AML detection
          </span>
          <h2 className="mt-5 text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
            Expose hidden{" "}
            <span className="bg-gradient-to-r from-rose-300 via-rose-400 to-amber-300 bg-clip-text text-transparent">money-laundering rings</span>{" "}
            in seconds.
          </h2>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-400">
            Criminals split dirty money across many accounts so every single transfer looks normal. Aegis maps the whole network, finds the loops where funds
            return to their source, and drafts the compliance report for you.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              onClick={onDemo}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 shadow-[0_0_28px_rgba(16,185,129,0.4)] transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" />
              Try the demo dataset
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={onBrowse}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-100 transition hover:border-emerald-400/50 hover:bg-slate-800 disabled:opacity-60"
            >
              <Upload className="h-4 w-4" />
              Upload your CSV
            </button>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-400">
            <li className="flex items-center gap-2"><Lock className="h-4 w-4 text-emerald-300" /> Runs 100% in your browser</li>
            <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Data never leaves your machine</li>
            <li className="flex items-center gap-2"><Zap className="h-4 w-4 text-emerald-300" /> Results in milliseconds</li>
          </ul>
        </div>
        <HeroGraph animate={!reduceMotion} />
      </section>

      {/* Upload zone */}
      <section aria-label="Upload transactions">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            onFile(e.dataTransfer.files?.[0]);
          }}
          className={`relative overflow-hidden rounded-2xl border-2 border-dashed p-6 transition sm:p-8 ${
            dragging
              ? "border-emerald-400 bg-emerald-500/10 shadow-[0_0_40px_rgba(16,185,129,0.25)]"
              : "border-slate-700 bg-slate-900/60 hover:border-emerald-400/50"
          }`}
        >
          <div className="grid items-center gap-6 lg:grid-cols-[1fr_auto]">
            <div className="flex items-start gap-4">
              <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ring-1 ${dragging ? "bg-emerald-500/20 ring-emerald-400/60" : "bg-slate-950 ring-slate-700"}`}>
                <Upload className={`h-6 w-6 ${dragging ? "text-emerald-300" : "text-slate-400"}`} />
              </div>
              <div>
                <p className="text-lg font-semibold text-white">{dragging ? "Release to analyse" : "Drag & drop your transactions file here"}</p>
                <p className="mt-1 text-sm text-slate-400">
                  Accepts <code className="text-emerald-300">.csv</code> with columns <code className="text-emerald-300">sender, receiver, amount, timestamp</code>
                </p>
                <button onClick={onSample} className="mt-2 text-xs text-slate-500 underline-offset-4 transition hover:text-slate-300 hover:underline">
                  Download a sample CSV to see the format
                </button>
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-relaxed text-slate-400">
{`sender,receiver,amount,timestamp
ACC-9101,ACC-9102,462000,2026-10-13T03:00:00Z
ACC-9102,ACC-9103,455070,2026-10-13T16:00:00Z
ACC-9103,ACC-9101,448140,2026-10-14T05:00:00Z`}
            </pre>
          </div>
          {busy && (
            <div className="mt-6">
              <PipelineStrip stage={stage} />
            </div>
          )}
          {error && (
            <div role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
      </section>

      {/* How it works */}
      <section aria-label="How it works">
        <h3 className="text-center text-2xl font-semibold text-white">How Aegis works</h3>
        <p className="mx-auto mt-2 max-w-xl text-center text-slate-400">From raw transactions to a regulator-ready draft in four steps.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map(({ Icon, title, text, tone }, i) => (
            <div key={title} className="group relative rounded-2xl border border-slate-800 bg-slate-900/70 p-5 transition duration-300 hover:-translate-y-1 hover:border-slate-600 hover:shadow-xl">
              <span className="absolute right-4 top-4 text-sm font-semibold text-slate-700">0{i + 1}</span>
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${tone}`}>
                <Icon className="h-5 w-5" />
              </span>
              <p className="mt-4 font-semibold text-white">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Typologies */}
      <section aria-label="What Aegis catches">
        <h3 className="text-center text-2xl font-semibold text-white">What Aegis catches</h3>
        <p className="mx-auto mt-2 max-w-xl text-center text-slate-400">
          Simple threshold rules miss these because each transfer looks ordinary. The pattern only appears in the network.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {TYPOLOGIES.map((t) => (
            <div key={t.title} className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 transition duration-300 hover:border-rose-400/40 hover:shadow-[0_0_30px_rgba(244,63,94,0.15)]">
              <div className="shrink-0 rounded-xl border border-slate-800 bg-slate-950 p-1">
                <MiniRing n={t.n} />
              </div>
              <div>
                <p className="font-semibold text-white">{t.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">{t.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------- Page ---------------------------------- */

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [hasTime, setHasTime] = useState(true);
  const [fileName, setFileName] = useState("");
  const [params, setParams] = useState<Params>({ windowH: 168, minSize: 3 });
  const [stage, setStage] = useState(-1);
  const [error, setError] = useState("");
  const [scanMsg, setScanMsg] = useState("");
  const [dragging, setDragging] = useState(false);

  const [selected, setSelected] = useState(0);
  const [typed, setTyped] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  const busy = stage >= 0;

  const result = useMemo(() => {
    if (!txns) return { analysis: null as Analysis | null, err: "" };
    try {
      return { analysis: analyze(txns, params), err: "" };
    } catch {
      return {
        analysis: null as Analysis | null,
        err: "This graph is too large or deep to analyse in the browser. Try a smaller file.",
      };
    }
  }, [txns, params]);
  const analysis = result.analysis;

  const ring = analysis && analysis.rings.length ? analysis.rings[Math.min(selected, analysis.rings.length - 1)] : null;
  const ringIdx = ring && analysis ? analysis.rings.indexOf(ring) : -1;
  const narrative = useMemo(() => (ring ? buildNarrative(ring, hasTime) : ""), [ring, hasTime]);
  const nodeMap = useMemo(() => new Map((analysis?.nodes ?? []).map((n) => [n.id, n])), [analysis]);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(m.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  // Reset the narrative whenever the data, parameters or selected ring change
  useEffect(() => {
    setTyped(0);
    setGenerating(false);
    setGenerated(false);
  }, [analysis, ringIdx]);
  useEffect(() => setSelected(0), [analysis]);

  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => {
      setTyped((t) => {
        const next = t + 8;
        if (next >= narrative.length) {
          clearInterval(id);
          setGenerating(false);
          setGenerated(true);
          return narrative.length;
        }
        return next;
      });
    }, 16);
    return () => clearInterval(id);
  }, [generating, narrative]);

  useEffect(() => {
    if (!scanMsg) return;
    const id = setTimeout(() => setScanMsg(""), 6000);
    return () => clearTimeout(id);
  }, [scanMsg]);

  const runStages = async (apply?: () => void) => {
    for (let i = 0; i < STAGES.length; i++) {
      setStage(i);
      await sleep(reduceMotion ? 80 : 420);
    }
    apply?.();
    setStage(-1);
  };

  const loadText = async (text: string, name: string) => {
    setError("");
    setScanMsg("");
    const parsed = parseCSV(text);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setFileName(name);
    await runStages(() => {
      setTxns(parsed.rows);
      setHasTime(parsed.hasTime);
    });
  };

  const onFile = async (file?: File | null) => {
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setError("Please upload a .csv file.");
      return;
    }
    await loadText(await file.text(), file.name);
  };

  // Announce what the last analysis found
  const lastAnalysis = useRef<Analysis | null>(null);
  useEffect(() => {
    if (analysis && analysis !== lastAnalysis.current && !busy) {
      lastAnalysis.current = analysis;
      setScanMsg(
        analysis.rings.length
          ? `Analysis complete in ${analysis.ms} ms · ${analysis.rings.length} laundering ring${analysis.rings.length > 1 ? "s" : ""} detected`
          : `Analysis complete in ${analysis.ms} ms · no layered rings found with these settings`
      );
    }
  }, [analysis, busy]);

  const rescan = async () => {
    await runStages();
    if (analysis) setScanMsg(`Rescan complete · ${analysis.rings.length} ring${analysis.rings.length === 1 ? "" : "s"} confirmed`);
  };

  const startGenerate = () => {
    if (!ring) return;
    if (reduceMotion) {
      setTyped(narrative.length);
      setGenerated(true);
      return;
    }
    setTyped(0);
    setGenerated(false);
    setGenerating(true);
  };

  const shown = generated ? narrative : narrative.slice(0, typed);
  const blocks = shown ? shown.split("\n\n") : [];

  const copyNarrative = async () => {
    try {
      await navigator.clipboard.writeText(narrative);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  const exportOne = () => {
    if (!ring) return;
    downloadText(
      `SAR-${ring.id}.txt`,
      `PROJECT AEGIS - SUSPICIOUS ACTIVITY REPORT (DRAFT)\nSource file: ${fileName}\nGenerated: ${new Date().toISOString()}\n\n${narrative}`
    );
  };

  const exportAll = () => {
    if (!analysis || !analysis.rings.length) return;
    const body = analysis.rings
      .map((r) => `==== ${r.id} (risk ${r.risk}/100) ====\n\n${buildNarrative(r, hasTime)}`)
      .join("\n\n\n");
    downloadText(
      "SAR-report-all-rings.txt",
      `PROJECT AEGIS - SUSPICIOUS ACTIVITY REPORT (DRAFT)\nSource file: ${fileName}\nGenerated: ${new Date().toISOString()}\nRings detected: ${analysis.rings.length}\n\n${body}`
    );
  };

  /* --------------------------- derived display values -------------------------- */

  const metrics = [
    {
      label: "Total Transactions Scanned",
      value: analysis ? analysis.txCount.toLocaleString("en-US") : "—",
      sub: analysis ? `${analysis.accountCount.toLocaleString("en-US")} accounts · ${usdShort(analysis.totalVolume)} total` : "Upload a file to begin",
      Icon: Database,
      ring: "hover:border-sky-400/50 hover:shadow-sky-500/20",
      icon: "text-sky-300 bg-sky-500/10 ring-sky-400/20",
      bar: "bg-sky-400",
    },
    {
      label: "High-Risk Laundering Rings",
      value: analysis ? `${analysis.rings.length} Active Cluster${analysis.rings.length === 1 ? "" : "s"}` : "—",
      sub: analysis ? `${analysis.rings.reduce((s, r) => s + r.accounts.length, 0)} accounts involved` : "Awaiting data",
      Icon: Network,
      ring: "hover:border-rose-400/50 hover:shadow-rose-500/25",
      icon: "text-rose-300 bg-rose-500/10 ring-rose-400/20",
      bar: "bg-rose-400",
    },
    {
      label: "Suspicious Volume Flagged",
      value: analysis ? usdShort(analysis.flaggedVolume) : "—",
      sub: analysis ? `${analysis.totalVolume > 0 ? ((analysis.flaggedVolume / analysis.totalVolume) * 100).toFixed(1) : 0}% of total volume` : "Awaiting data",
      Icon: DollarSign,
      ring: "hover:border-amber-400/50 hover:shadow-amber-500/20",
      icon: "text-amber-300 bg-amber-500/10 ring-amber-400/20",
      bar: "bg-amber-400",
    },
    {
      label: "System Risk Index",
      value: analysis ? `${analysis.riskLabel} / ${analysis.riskIndex}%` : "—",
      sub: analysis ? (analysis.riskIndex >= 60 ? "Escalation recommended" : "No escalation needed") : "Awaiting data",
      Icon: Gauge,
      ring: "hover:border-rose-400/60 hover:shadow-rose-500/30",
      icon: "text-rose-300 bg-rose-500/10 ring-rose-400/30",
      bar: "bg-rose-500",
    },
  ];

  const caseStats = ring
    ? [
        { label: "Accounts", value: String(ring.accounts.length) },
        { label: "Volume", value: usd(ring.volume) },
        { label: "Window", value: ring.hours < 1 ? "<1h" : `${Math.round(ring.hours)}h` },
        { label: "Risk score", value: `${ring.risk}/100` },
      ]
    : [];

  /* ---------------------------------- render ---------------------------------- */

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 selection:bg-emerald-500/30">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(244,63,94,0.07),transparent_50%)]"
      />
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt,text/csv"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        {/* ------------------------------ Header ------------------------------ */}
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30 shadow-[0_0_24px_rgba(16,185,129,0.25)]">
              <ShieldCheck className="h-6 w-6 text-emerald-300" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-[0.18em] text-white sm:text-3xl">PROJECT AEGIS</h1>
              <p className="text-sm text-slate-400">
                AML Financial Intelligence Engine · Layered laundering network detection
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div
              className="flex items-center gap-2 whitespace-nowrap rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-1.5 text-sm font-medium text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.25)]"
              role="status"
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
              </span>
              AI Engine Active
            </div>

            <button
              onClick={rescan}
              disabled={busy || !txns}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-emerald-400/50 hover:bg-slate-800 hover:shadow-[0_0_18px_rgba(16,185,129,0.2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4 text-emerald-300" />}
              {busy ? "Scanning…" : "Scan Network"}
            </button>

            <button
              onClick={exportAll}
              disabled={!analysis || analysis.rings.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_0_20px_rgba(244,63,94,0.35)] transition hover:bg-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Download className="h-4 w-4" />
              Export SAR Report
            </button>
          </div>
        </header>

        {!txns ? (
          <Landing
            busy={busy}
            stage={stage}
            error={error || result.err}
            dragging={dragging}
            setDragging={setDragging}
            onFile={onFile}
            onBrowse={() => fileRef.current?.click()}
            onDemo={() => loadText(makeDemoCSV(), "aegis-demo-transactions.csv")}
            onSample={() => downloadText("aegis-sample-transactions.csv", makeDemoCSV())}
            reduceMotion={reduceMotion}
          />
        ) : (
          <>
        {/* ---------------------------- Metric cards --------------------------- */}
        <section aria-label="Key metrics" className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map(({ label, value, sub, Icon, ring: hov, icon, bar }, i) => (
            <div
              key={label}
              className={`group relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-5 backdrop-blur transition duration-300 hover:-translate-y-0.5 hover:shadow-xl ${hov}`}
            >
              <div className={`absolute inset-x-0 top-0 h-px ${bar} opacity-60`} />
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-slate-400">{label}</p>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ${icon}`}>
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-4 text-3xl font-semibold tabular-nums tracking-tight text-white">{value}</p>
              <p className="mt-1 text-sm text-slate-500">{sub}</p>
              {i === 3 && (
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.7)] transition-all duration-700"
                    style={{ width: `${analysis ? analysis.riskIndex : 0}%` }}
                    role="progressbar"
                    aria-valuenow={analysis ? analysis.riskIndex : 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="System risk index"
                  />
                </div>
              )}
            </div>
          ))}
        </section>

        {/* ----------------------------- Workspace ----------------------------- */}
        <section className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
          {/* Graph canvas */}
          <div className="flex min-w-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/70 shadow-[0_0_40px_rgba(2,6,23,0.6)] xl:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-emerald-300" />
                <h2 className="text-base font-semibold text-white sm:text-lg">
                  Live Transaction Topology &amp; Ring Detection
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                  Normal account
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e]" />
                  Flagged ring member
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-px w-4 border-t border-dashed border-slate-400" />
                  Link to ring
                </span>
              </div>
            </div>

            <div className="relative flex-1 p-3 sm:p-5">
              {/* Data source bar + detection parameters */}
              {txns && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-300" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-100">{fileName}</p>
                      <p className="text-xs text-slate-500">
                        {analysis ? `${analysis.txCount.toLocaleString("en-US")} transactions loaded` : "Loaded"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                    <label className="flex items-center gap-2">
                      Time window
                      <select
                        value={params.windowH}
                        onChange={(e) => setParams((p) => ({ ...p, windowH: Number(e.target.value) }))}
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      >
                        {WINDOWS.map((w) => (
                          <option key={w.h} value={w.h}>
                            {w.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2">
                      Min ring size
                      <select
                        value={params.minSize}
                        onChange={(e) => setParams((p) => ({ ...p, minSize: Number(e.target.value) }))}
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      >
                        {[3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n} accounts
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 font-medium text-slate-100 transition hover:border-emerald-400/50 disabled:opacity-50"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Replace file
                    </button>
                  </div>
                </div>
              )}

              {busy && (
                <div className="mb-3">
                  <PipelineStrip stage={stage} />
                </div>
              )}

              {(error || result.err) && (
                <div
                  role="alert"
                  className="mb-3 flex items-start gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {error || result.err}
                </div>
              )}

              <div
                className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950 bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:32px_32px]"
                style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
              >
                {analysis ? (
                  <svg
                    viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
                    className="absolute inset-0 block h-full w-full"
                    role="img"
                    aria-label="Transaction network graph with detected laundering rings highlighted"
                  >
                    <defs>
                      <marker id="arrow-rose" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M0 0 L10 5 L0 10 z" fill="#fb7185" />
                      </marker>
                      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="b" />
                        <feMerge>
                          <feMergeNode in="b" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
                      </filter>
                    </defs>

                    {/* Non-ring links */}
                    {analysis.links
                      .filter((l) => l.ring < 0)
                      .map((l, i) => {
                        const a = nodeMap.get(l.a);
                        const b = nodeMap.get(l.b);
                        if (!a || !b) return null;
                        const toRing = a.ring >= 0 || b.ring >= 0;
                        return (
                          <line
                            key={`nl-${i}`}
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={toRing ? "#94a3b8" : "#34d399"}
                            strokeOpacity={toRing ? 0.3 : 0.2}
                            strokeDasharray={toRing ? "4 5" : undefined}
                            strokeWidth={1.2}
                          />
                        );
                      })}

                    {/* Rings */}
                    {Array.from({ length: analysis.shown }).map((_, ci) => {
                      const r = analysis.rings[ci];
                      const active = ci === ringIdx;
                      const animate = active && !reduceMotion;
                      const members = analysis.nodes.filter((n) => n.ring === ci);
                      const cx = members.reduce((s, n) => s + n.x, 0) / members.length;
                      const cy = members.reduce((s, n) => s + n.y, 0) / members.length;
                      return (
                        <g
                          key={r.id}
                          opacity={active ? 1 : 0.5}
                          className="cursor-pointer transition-opacity hover:opacity-100"
                          onClick={() => setSelected(ci)}
                        >
                          <title>{`${r.id} · ${r.typology} · click to select`}</title>
                          {analysis.links
                            .filter((l) => l.ring === ci)
                            .map((l, i) => {
                              const a = nodeMap.get(l.a)!;
                              const b = nodeMap.get(l.b)!;
                              const dx = b.x - a.x;
                              const dy = b.y - a.y;
                              const len = Math.hypot(dx, dy) || 1;
                              const ux = dx / len;
                              const uy = dy / len;
                              return (
                                <line
                                  key={`rl-${i}`}
                                  x1={a.x + ux * 14}
                                  y1={a.y + uy * 14}
                                  x2={b.x - ux * 18}
                                  y2={b.y - uy * 18}
                                  stroke="#fb7185"
                                  strokeWidth={active ? 2.5 : 1.8}
                                  markerEnd="url(#arrow-rose)"
                                  strokeDasharray={active ? "6 4" : undefined}
                                  filter={active ? "url(#glow)" : undefined}
                                >
                                  {animate && (
                                    <animate attributeName="stroke-dashoffset" from="20" to="0" dur="1.2s" repeatCount="indefinite" />
                                  )}
                                </line>
                              );
                            })}
                          {members.map((n) => (
                            <g key={n.id}>
                              {animate && (
                                <circle cx={n.x} cy={n.y} r={14} fill="none" stroke="#f43f5e" strokeOpacity={0.5}>
                                  <animate attributeName="r" values="12;22;12" dur="2.4s" repeatCount="indefinite" />
                                  <animate attributeName="stroke-opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite" />
                                </circle>
                              )}
                              <circle cx={n.x} cy={n.y} r={10} fill="#f43f5e" stroke="#fecdd3" strokeWidth={1.5} filter="url(#glow)" />
                              {active && (
                                <text x={n.x} y={n.y + (n.y > cy ? 24 : -16)} textAnchor="middle" className="fill-slate-300 text-[9px]">
                                  {n.id.length > 12 ? n.id.slice(0, 12) : n.id}
                                </text>
                              )}
                            </g>
                          ))}
                          <text x={cx} y={cy + 4} textAnchor="middle" className="fill-rose-200 text-[11px] font-semibold">
                            {r.id}
                          </text>
                        </g>
                      );
                    })}

                    {/* Normal nodes */}
                    {analysis.nodes
                      .filter((n) => n.ring < 0)
                      .map((n) => (
                        <circle key={n.id} cx={n.x} cy={n.y} r={6} fill="#10b981" stroke="#a7f3d0" strokeWidth={1.2} filter="url(#glow)">
                          <title>{n.id}</title>
                        </circle>
                      ))}

                    {busy && (
                      <rect x="0" y="0" width={CANVAS_W} height="3" fill="#34d399" opacity="0.7">
                        <animate attributeName="y" from="0" to={CANVAS_H} dur="1.3s" repeatCount="indefinite" />
                      </rect>
                    )}
                  </svg>
                ) : (
                  /* Upload dropzone */
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      onFile(e.dataTransfer.files?.[0]);
                    }}
                    className={`absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center transition ${
                      dragging ? "bg-emerald-500/10" : ""
                    }`}
                  >
                    <div
                      className={`flex h-14 w-14 items-center justify-center rounded-2xl ring-1 transition ${
                        dragging ? "bg-emerald-500/20 ring-emerald-400/60" : "bg-slate-900 ring-slate-700"
                      }`}
                    >
                      <Upload className={`h-6 w-6 ${dragging ? "text-emerald-300" : "text-slate-400"}`} />
                    </div>
                    <div>
                      <p className="text-base font-semibold text-white">Drop a transactions CSV to analyse</p>
                      <p className="mt-1 text-sm text-slate-400">
                        Columns: <code className="text-emerald-300">sender, receiver, amount, timestamp</code>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <button
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] transition hover:bg-emerald-400 disabled:opacity-60"
                      >
                        <Upload className="h-4 w-4" />
                        Browse file
                      </button>
                      <button
                        onClick={() => loadText(makeDemoCSV(), "aegis-demo-transactions.csv")}
                        disabled={busy}
                        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-emerald-400/50 disabled:opacity-60"
                      >
                        <Sparkles className="h-4 w-4 text-emerald-300" />
                        Load demo dataset
                      </button>
                    </div>
                    <button
                      onClick={() => downloadText("aegis-sample-transactions.csv", makeDemoCSV())}
                      className="text-xs text-slate-500 underline-offset-4 transition hover:text-slate-300 hover:underline"
                    >
                      Download sample CSV
                    </button>
                  </div>
                )}
              </div>

              <p className="mt-3 min-h-[1.25rem] text-xs text-emerald-300/90" role="status" aria-live="polite">
                {busy ? STAGES[stage] + "…" : scanMsg}
              </p>

              {/* Cluster selector */}
              {analysis && analysis.rings.length > 0 && (
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {analysis.rings.slice(0, 6).map((c, i) => (
                    <button
                      key={c.id}
                      onClick={() => setSelected(i)}
                      aria-pressed={i === ringIdx}
                      className={`rounded-xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
                        i === ringIdx
                          ? "border-rose-400/60 bg-rose-500/10 shadow-[0_0_20px_rgba(244,63,94,0.2)]"
                          : "border-slate-800 bg-slate-900 hover:border-slate-600"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white">{c.id}</span>
                        <span className="whitespace-nowrap rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300">
                          Risk {c.risk}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{c.typology}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        {c.accounts.length} accounts · {usd(c.volume)} · {c.hours < 1 ? "<1" : Math.round(c.hours)}h
                      </p>
                    </button>
                  ))}
                </div>
              )}
              {analysis && analysis.rings.length > 6 && (
                <p className="mt-2 text-xs text-slate-500">
                  Showing the 6 highest-risk rings; {analysis.rings.length - 6} more are included in the exported report.
                </p>
              )}
              {analysis && analysis.rings.length === 0 && (
                <div className="mt-2 flex items-start gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  No circular fund flows found with the current settings. Try a wider time window or a smaller minimum ring size.
                </div>
              )}
            </div>
          </div>

          {/* SAR sidebar */}
          <aside className="flex min-w-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/70 shadow-[0_0_40px_rgba(2,6,23,0.6)]">
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="h-5 w-5 shrink-0 text-rose-300" />
                <div className="min-w-0">
                  <h2 className="whitespace-nowrap text-base font-semibold text-white sm:text-lg">SAR Generator</h2>
                  <p className="text-xs text-slate-400">AI compliance assistant</p>
                </div>
              </div>
              {ring && (
                <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300">
                  <AlertTriangle className="h-3 w-3" />
                  {ring.id}
                </span>
              )}
            </div>

            <div className="flex flex-1 flex-col gap-4 p-5">
              {ring && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-sm font-medium text-rose-200">{ring.typology}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    {caseStats.map((s) => (
                      <div key={s.label}>
                        <dt className="text-xs text-slate-500">{s.label}</dt>
                        <dd className="text-sm font-semibold tabular-nums text-slate-100">{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 text-xs text-slate-500">Flow of funds</p>
                  <p className="mt-1 break-words text-xs leading-relaxed text-slate-300">
                    {ring.accounts.slice(0, 6).join(" → ")}
                    {ring.accounts.length > 6 ? ` → … (+${ring.accounts.length - 6})` : ""} → {ring.accounts[0]}
                  </p>
                </div>
              )}

              <button
                onClick={startGenerate}
                disabled={generating || !ring}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 hover:shadow-[0_0_20px_rgba(16,185,129,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generating ? "Drafting narrative…" : generated ? "Regenerate narrative" : "Generate SAR narrative"}
              </button>

              <div
                className="min-h-[240px] flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm leading-relaxed text-slate-300 xl:max-h-[480px]"
                aria-live="polite"
              >
                {blocks.length > 0 ? (
                  <div className="space-y-4">
                    {blocks.map((b, i) => {
                      const [head, ...rest] = b.split("\n");
                      const isHeading = /^[A-Z &]{6,}$/.test(head);
                      const isLast = i === blocks.length - 1;
                      const cursor = generating && isLast && (
                        <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-emerald-400" />
                      );
                      return isHeading ? (
                        <div key={i}>
                          <h3 className="mb-1 text-xs font-semibold tracking-wider text-emerald-300">{head}</h3>
                          <p>
                            {rest.join("\n")}
                            {cursor}
                          </p>
                        </div>
                      ) : (
                        <p key={i} className="text-xs italic text-slate-500">
                          {b}
                          {cursor}
                        </p>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 ring-1 ring-slate-700">
                      <FileText className="h-5 w-5 text-slate-500" />
                    </span>
                    <p className="mt-3 font-medium text-slate-300">
                      {ring ? "No narrative drafted yet" : analysis ? "No flagged rings to report" : "Waiting for transaction data"}
                    </p>
                    <p className="mt-1 max-w-xs text-slate-500">
                      {ring
                        ? `Generate a plain-language explanation of why ${ring.id} is consistent with money laundering, ready for compliance review.`
                        : analysis
                        ? "Adjust the detection settings to look for other patterns."
                        : "Upload a CSV or load the demo dataset. Detected rings will appear here with an auto-drafted SAR narrative."}
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={copyNarrative}
                  disabled={!generated}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={exportOne}
                  disabled={!generated}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Download className="h-4 w-4" />
                  Export
                </button>
              </div>
            </div>
          </aside>
        </section>

          </>
        )}

        <footer className="mt-8 border-t border-slate-800 pt-4 text-center text-xs text-slate-500">
          Project Aegis · PS 2.1 Graph-Based Detection of Layered Money Laundering Networks · Analysis runs locally in your browser
        </footer>
      </div>
    </main>
  );
}