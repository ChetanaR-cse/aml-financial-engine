"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  Copy,
  Database,
  DollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  Gauge,
  GitBranch,
  Loader2,
  Lock,
  Network,
  Radar,
  ShieldCheck,
  Sparkles,
  Upload,
  Zap,
} from "lucide-react";

/* ========================= LOGIC START (pure, testable) ========================= */

type Pt = { x: number; y: number };
type Txn = { from: string; to: string; amount: number; t: number; label?: number };
type Edge = { from: string; to: string; amount: number; count: number };
type Params = { windowH: number; minSize: number; fanK: number; minRisk: number };
type Factor = { label: string; pts: number; max: number; note: string };
type Cluster = {
  id: string;
  accounts: string[]; // ordered for drawing (cycle order first)
  roles: Record<string, string[]>;
  patterns: string[];
  topology: string;
  volume: number;
  txCount: number;
  hours: number;
  risk: number;
  factors: Factor[];
  firstTs: number;
  lastTs: number;
  maxTransfer: number;
  minTransfer: number;
  retention: number; // average fraction of an incoming amount that is forwarded
  txns: Txn[]; // time-ordered transfers between members
};
type ViewNode = { id: string; x: number; y: number; ring: number };
type ViewLink = { a: string; b: string; ring: number };
type Analysis = {
  txCount: number;
  accountCount: number;
  totalVolume: number;
  rings: Cluster[]; // ranked by risk
  nodes: ViewNode[];
  links: ViewLink[];
  shown: number;
  flaggedVolume: number;
  riskIndex: number;
  riskLabel: string;
  counts: { cycles: number; fanOut: number; fanIn: number; passThrough: number };
  ms: number;
};

const CANVAS_W = 960;
const CANVAS_H = 540;
const HOUR = 3_600_000;
const FAN_HOURS = 24;
const PASS_HOURS = 24;
const MAX_SHOWN = 8;

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
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function usdShort(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return usd(n);
}
function fmtDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
function fmtDur(h: number) {
  if (h < 1) return "under 1 hour";
  if (h < 48) return `${Math.round(h)} hours`;
  return `${(h / 24).toFixed(1)} days`;
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
const LABEL_KEYS = ["is_suspicious", "label", "is_laundering", "suspicious", "is_fraud", "fraud", "laundering", "ground_truth"];

function parseCSV(text: string): { rows: Txn[]; hasTime: boolean; hasLabels: boolean; skipped: number; error?: string } {
  const empty = { rows: [] as Txn[], hasTime: false, hasLabels: false, skipped: 0 };
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { ...empty, error: "The file needs a header row and at least one transaction." };
  if (lines.length > 300_001) return { ...empty, error: "File too large for in-browser analysis (limit 300,000 rows)." };

  const header = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const find = (keys: string[]) => header.findIndex((h) => keys.includes(h));
  const iFrom = find(FROM_KEYS);
  const iTo = find(TO_KEYS);
  const iAmt = find(AMT_KEYS);
  const iTime = find(TIME_KEYS);
  const iLabel = find(LABEL_KEYS);
  if (iFrom < 0 || iTo < 0 || iAmt < 0) {
    return { ...empty, error: "Could not find required columns. Expected: sender, receiver, amount (and optionally timestamp, is_suspicious)." };
  }

  const rows: Txn[] = [];
  let timeOk = iTime >= 0;
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i]);
    const from = c[iFrom];
    const to = c[iTo];
    const amount = parseFloat((c[iAmt] ?? "").replace(/[$,\s]/g, ""));
    if (!from || !to || from === to || !isFinite(amount) || amount <= 0) {
      skipped++;
      continue;
    }
    let t = iTime >= 0 ? Date.parse(c[iTime] ?? "") : NaN;
    if (isNaN(t)) {
      timeOk = false;
      t = i * HOUR;
    }
    const row: Txn = { from, to, amount, t };
    if (iLabel >= 0) row.label = /^(1|true|yes|y|suspicious)$/i.test(c[iLabel] ?? "") ? 1 : 0;
    rows.push(row);
  }
  if (rows.length === 0) return { ...empty, skipped, error: "No valid transactions found (check amounts and account columns)." };
  return { rows, hasTime: timeOk, hasLabels: iLabel >= 0, skipped };
}

/* ------------------------------ Detection ------------------------------ */

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
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
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

// A real laundering loop respects time: every hop happens AFTER the previous one.
function findTimedCycle(inner: Txn[], windowMs: number, minLen: number, maxLen: number): Txn[] | null {
  const byFrom = new Map<string, Txn[]>();
  for (const x of inner) {
    const l = byFrom.get(x.from);
    if (l) l.push(x);
    else byFrom.set(x.from, [x]);
  }
  let steps = 0;
  for (const s of inner) {
    const path: Txn[] = [s];
    const visited = new Set<string>([s.from, s.to]);
    const dfs = (cur: string, curT: number): Txn[] | null => {
      if (steps++ > 40_000) return null;
      const tried = new Set<string>();
      for (const x of byFrom.get(cur) ?? []) {
        if (x.t <= curT) continue;
        if (x.t - s.t > windowMs) break;
        if (tried.has(x.to)) continue;
        tried.add(x.to);
        if (x.to === s.from) {
          if (path.length + 1 >= minLen) return [...path, x];
          continue;
        }
        if (visited.has(x.to) || path.length + 1 >= maxLen) continue;
        visited.add(x.to);
        path.push(x);
        const r = dfs(x.to, x.t);
        if (r) return r;
        path.pop();
        visited.delete(x.to);
      }
      return null;
    };
    const r = dfs(s.to, s.t);
    if (r) return r;
    if (steps > 40_000) break;
  }
  return null;
}

function analyze(txnsIn: Txn[], p: Params): Analysis {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const txns = [...txnsIn].sort((a, b) => a.t - b.t);
  const outs = new Map<string, Txn[]>();
  const ins = new Map<string, Txn[]>();
  const edges = new Map<string, Edge>();
  const adj = new Map<string, string[]>();
  let totalVolume = 0;
  const push = (m: Map<string, Txn[]>, k: string, v: Txn) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };

  for (const x of txns) {
    totalVolume += x.amount;
    push(outs, x.from, x);
    push(ins, x.to, x);
    if (!adj.has(x.from)) adj.set(x.from, []);
    if (!adj.has(x.to)) adj.set(x.to, []);
    const k = x.from + "\u0001" + x.to;
    const e = edges.get(k);
    if (e) {
      e.amount += x.amount;
      e.count++;
    } else {
      edges.set(k, { from: x.from, to: x.to, amount: x.amount, count: 1 });
      adj.get(x.from)!.push(x.to);
    }
  }

  const roles = new Map<string, Set<string>>();
  const addRole = (a: string, r: string) => {
    const s = roles.get(a);
    if (s) s.add(r);
    else roles.set(a, new Set([r]));
  };
  const counts = { cycles: 0, fanOut: 0, fanIn: 0, passThrough: 0 };

  // 1) time-respecting cycles
  const cycles: Txn[][] = [];
  for (const comp of tarjan(adj)) {
    if (comp.length < p.minSize || comp.length > 15) continue;
    const set = new Set(comp);
    const inner: Txn[] = [];
    for (const a of comp) for (const x of outs.get(a) ?? []) if (set.has(x.to)) inner.push(x);
    inner.sort((a, b) => a.t - b.t);
    const cyc = findTimedCycle(inner, p.windowH * HOUR, p.minSize, 15);
    if (!cyc) continue;
    cycles.push(cyc);
    counts.cycles++;
    for (const x of cyc) addRole(x.from, "Cycle member");
  }

  // 2) fan-out / fan-in bursts (only material transfers: the top 10% by value, so dust is ignored)
  const sortedAmts = txns.map((x) => x.amount).sort((a, b) => a - b);
  const bigAmt = sortedAmts[Math.floor(0.9 * (sortedAmts.length - 1))] ?? 0;
  const partners = new Set<string>();
  const fan = (map: Map<string, Txn[]>, key: "to" | "from", role: string) => {
    for (const [acc, full] of map) {
      if (full.length < p.fanK) continue;
      const list = full.filter((x) => x.amount >= bigAmt);
      if (list.length < p.fanK) continue;
      const cnt = new Map<string, number>();
      let j = 0;
      let best: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const k = list[i][key];
        cnt.set(k, (cnt.get(k) ?? 0) + 1);
        while (list[i].t - list[j].t > FAN_HOURS * HOUR) {
          const kj = list[j][key];
          const c = cnt.get(kj)! - 1;
          if (c === 0) cnt.delete(kj);
          else cnt.set(kj, c);
          j++;
        }
        if (cnt.size >= p.fanK && cnt.size > best.length) best = [...cnt.keys()];
      }
      if (best.length) {
        addRole(acc, role);
        role === "Fan-out hub" ? counts.fanOut++ : counts.fanIn++;
        for (const b of best) partners.add(b);
      }
    }
  };
  fan(outs, "to", "Fan-out hub");
  fan(ins, "from", "Fan-in hub");

  // 3) rapid pass-through: a large amount comes in and almost all of it goes out within hours
  const passRatios = new Map<string, number[]>();
  for (const [acc, inList] of ins) {
    const outList = outs.get(acc);
    if (!outList) continue;
    let ptr = 0;
    const rs: number[] = [];
    for (const i of inList) {
      if (i.amount < bigAmt) continue;
      while (ptr < outList.length && outList[ptr].t < i.t) ptr++;
      for (let k = ptr; k < outList.length; k++) {
        const o = outList[k];
        if (o.t - i.t > PASS_HOURS * HOUR) break;
        const r = o.amount / i.amount;
        if (r >= 0.85 && r <= 1) {
          rs.push(r);
          break;
        }
      }
    }
    if (rs.length) {
      addRole(acc, "Pass-through");
      passRatios.set(acc, rs);
      counts.passThrough++;
    }
  }

  // 4) connected suspicious clusters
  const flagged = new Set<string>([...roles.keys(), ...partners]);
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    let c = a;
    while (parent.get(c)! !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const a of flagged) parent.set(a, a);
  for (const e of edges.values()) if (flagged.has(e.from) && flagged.has(e.to)) parent.set(find(e.from), find(e.to));
  const groups = new Map<string, string[]>();
  for (const a of flagged) {
    const r = find(a);
    const g = groups.get(r);
    if (g) g.push(a);
    else groups.set(r, [a]);
  }

  const built: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2 || members.length > 40) continue;
    const set = new Set(members);
    const ctx: Txn[] = [];
    for (const a of members) for (const x of outs.get(a) ?? []) if (set.has(x.to)) ctx.push(x);
    if (ctx.length < 2) continue;
    ctx.sort((a, b) => a.t - b.t);

    const memberRoles: Record<string, string[]> = {};
    for (const a of members) memberRoles[a] = roles.has(a) ? [...roles.get(a)!] : ["Counterparty"];
    const has = (r: string) => members.some((a) => roles.get(a)?.has(r));
    const cyc = cycles.find((c) => set.has(c[0].from));
    const hasCycle = !!cyc;
    const fanOut = has("Fan-out hub");
    const fanIn = has("Fan-in hub");
    const pass = has("Pass-through");

    const firstTs = ctx[0].t;
    const lastTs = ctx[ctx.length - 1].t;
    const hours = (lastTs - firstTs) / HOUR;
    const amounts = ctx.map((x) => x.amount);
    const volume = amounts.reduce((s, v) => s + v, 0);
    const mean = volume / amounts.length;
    const sd = Math.sqrt(amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / amounts.length);
    const similarity = Math.max(0, 1 - sd / mean);
    const rs = members.flatMap((a) => passRatios.get(a) ?? []);
    const retention = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : 0;

    const patterns: string[] = [];
    if (hasCycle) patterns.push("Cycle");
    if (fanOut) patterns.push("Fan-out");
    if (fanIn) patterns.push("Fan-in");
    if (pass) patterns.push("Pass-through");

    const structure = hasCycle ? 30 : fanOut && fanIn ? 24 : fanOut || fanIn ? 14 : 12;
    const speed = hours <= 24 ? 20 : hours <= 72 ? 16 : hours <= 168 ? 11 : 5;
    const vol = volume >= 1_000_000 ? 15 : volume >= 250_000 ? 12 : volume >= 50_000 ? 8 : 4;
    const sim = Math.round(15 * similarity);
    const passPts = Math.min(10, rs.length * 2);
    const fanPts = fanOut && fanIn ? 10 : fanOut || fanIn ? 6 : 0;
    const factors: Factor[] = [
      {
        label: "Layering structure",
        pts: structure,
        max: 30,
        note: hasCycle
          ? `A time-ordered loop returns funds to the originator after ${cyc!.length} hops.`
          : fanOut && fanIn
          ? "Funds are split across many accounts, then gathered again (scatter-gather)."
          : fanOut
          ? "One account distributes funds to many recipients in a short burst."
          : fanIn
          ? "Many accounts feed one account in a short burst."
          : "A chain of accounts forwards funds almost unchanged.",
      },
      { label: "Speed of movement", pts: speed, max: 20, note: `All transfers completed within ${fmtDur(hours)}.` },
      { label: "Value at risk", pts: vol, max: 15, note: `${usd(volume)} moved between the linked accounts.` },
      { label: "Uniform amounts", pts: sim, max: 15, note: `Transfer sizes are ${Math.round(similarity * 100)}% consistent, which is unusual for real commerce.` },
      {
        label: "Pass-through behaviour",
        pts: passPts,
        max: 10,
        note: rs.length ? `${rs.length} hops forward ${Math.round(retention * 100)}% of what they received within ${PASS_HOURS} hours.` : "No rapid forwarding detected.",
      },
      { label: "Fan-out / fan-in", pts: fanPts, max: 10, note: fanOut || fanIn ? "Burst of many counterparties within 24 hours." : "No burst of counterparties." },
    ];
    const risk = Math.min(99, factors.reduce((s, f) => s + f.pts, 0));
    const topology =
      hasCycle && fanOut && fanIn
        ? "Cycle with scatter-gather"
        : hasCycle
        ? "Circular layering loop"
        : fanOut && fanIn
        ? "Scatter-gather (fan-out to fan-in)"
        : fanOut
        ? "Fan-out distribution"
        : fanIn
        ? "Fan-in aggregation"
        : "Rapid pass-through chain";

    // drawing order: cycle sequence first, then breadth-first from the remaining members
    const order: string[] = hasCycle ? cyc!.map((x) => x.from) : [];
    const seen = new Set(order);
    const queue = [...order];
    const bfs = () => {
      while (queue.length) {
        const cur = queue.shift()!;
        for (const x of outs.get(cur) ?? []) if (set.has(x.to) && !seen.has(x.to)) (seen.add(x.to), order.push(x.to), queue.push(x.to));
        for (const x of ins.get(cur) ?? []) if (set.has(x.from) && !seen.has(x.from)) (seen.add(x.from), order.push(x.from), queue.push(x.from));
      }
    };
    for (const a of members) {
      if (seen.has(a)) continue;
      seen.add(a);
      order.push(a);
      queue.push(a);
      bfs();
    }
    bfs();

    built.push({
      id: "",
      accounts: order,
      roles: memberRoles,
      patterns,
      topology,
      volume,
      txCount: ctx.length,
      hours,
      risk,
      factors,
      firstTs,
      lastTs,
      maxTransfer: Math.max(...amounts),
      minTransfer: Math.min(...amounts),
      retention,
      txns: ctx.slice(0, 400),
    });
  }

  const rings = built.filter((c) => c.risk >= p.minRisk).sort((a, b) => b.risk - a.risk || b.volume - a.volume);
  rings.forEach((c, i) => (c.id = `CL-${String(i + 1).padStart(3, "0")}`));

  // 5) layout: clusters on a grid, nearby ordinary accounts relaxed around them
  const shown = Math.min(MAX_SHOWN, rings.length);
  const pos = new Map<string, Pt>();
  const ringOf = new Map<string, number>();
  const centers: { c: Pt; r: number }[] = [];
  if (shown > 0) {
    const cols = shown <= 3 ? shown : shown <= 6 ? 3 : 4;
    const rowsN = Math.ceil(shown / cols);
    const cw = CANVAS_W / cols;
    const ch = CANVAS_H / rowsN;
    for (let i = 0; i < shown; i++) {
      const n = rings[i].accounts.length;
      const c = { x: ((i % cols) + 0.5) * cw, y: (Math.floor(i / cols) + 0.5) * ch };
      const maxR = Math.min(cw, ch) / 2 - 48;
      const r = Math.max(30, Math.min(28 + n * 9, maxR));
      centers.push({ c, r });
      rings[i].accounts.forEach((id, j) => {
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
  pick([...nearScore.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]), 18);
  pick([...nodeVol.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]), 28);

  const rnd = mulberry32(42);
  for (const id of free) pos.set(id, { x: 40 + rnd() * (CANVAS_W - 80), y: 40 + rnd() * (CANVAS_H - 80) });

  const links: ViewLink[] = [];
  for (const e of edges.values()) {
    if (!pos.has(e.from) || !pos.has(e.to)) continue;
    const ra = ringOf.get(e.from);
    const rb = ringOf.get(e.to);
    links.push({ a: e.from, b: e.to, ring: ra !== undefined && ra === rb ? ra : -1 });
    if (links.length >= 600) break;
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
        fx += (dx / d) * (700 / d);
        fy += (dy / d) * (700 / d);
      }
      for (const l of links) {
        if (l.a !== id && l.b !== id) continue;
        const o = pos.get(l.a === id ? l.b : l.a)!;
        const dx = o.x - p0.x;
        const dy = o.y - p0.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.5;
        const sp = 0.04 * (d - 100);
        fx += (dx / d) * sp;
        fy += (dy / d) * sp;
      }
      for (const { c, r } of centers) {
        const dx = p0.x - c.x;
        const dy = p0.y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.5;
        if (d < r + 55) {
          const push = (r + 55 - d) * 0.6;
          fx += (dx / d) * push;
          fy += (dy / d) * push;
        }
      }
      const mag = Math.sqrt(fx * fx + fy * fy);
      const k = mag > 12 ? 12 / mag : 1;
      p0.x = Math.min(CANVAS_W - 30, Math.max(30, p0.x + fx * k * 0.6));
      p0.y = Math.min(CANVAS_H - 30, Math.max(30, p0.y + fy * k * 0.6));
    }
  }

  const nodes: ViewNode[] = [];
  for (const [id, p0] of pos) nodes.push({ id, x: p0.x, y: p0.y, ring: freeSet.has(id) ? -1 : ringOf.get(id) ?? -1 });

  const flaggedVolume = rings.reduce((s, r) => s + r.volume, 0);
  const maxRisk = rings.reduce((m, r) => Math.max(m, r.risk), 0);
  const share = totalVolume > 0 ? flaggedVolume / totalVolume : 0;
  const riskIndex = rings.length ? Math.min(99, Math.round(0.7 * maxRisk + 30 * Math.min(1, share * 5))) : 8;
  const riskLabel = riskIndex >= 80 ? "Critical" : riskIndex >= 60 ? "High" : riskIndex >= 35 ? "Medium" : "Low";
  const done = typeof performance !== "undefined" ? performance.now() : Date.now();

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
    counts,
    ms: Math.max(1, Math.round(done - started)),
  };
}

/* ------------------------- Evaluation vs. baseline ------------------------- */

type Score = { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
type Evaluation = { truth: number; flaggedAegis: number; flaggedBase: number; aegis: Score; baseline: Score };

function scoreSets(pred: Set<string>, truth: Set<string>): Score {
  let tp = 0;
  for (const a of pred) if (truth.has(a)) tp++;
  const fp = pred.size - tp;
  const fn = truth.size - tp;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

// Account-level evaluation. Truth = accounts that appear in any transaction labelled suspicious.
function evaluate(txns: Txn[], flagged: Set<string>, threshold: number): Evaluation {
  const truth = new Set<string>();
  const base = new Set<string>();
  for (const x of txns) {
    if (x.label === 1) {
      truth.add(x.from);
      truth.add(x.to);
    }
    if (x.amount >= threshold) {
      base.add(x.from);
      base.add(x.to);
    }
  }
  return {
    truth: truth.size,
    flaggedAegis: flagged.size,
    flaggedBase: base.size,
    aegis: scoreSets(flagged, truth),
    baseline: scoreSets(base, truth),
  };
}

/* ------------------------------ SAR narrative ------------------------------ */

function buildNarrative(c: Cluster, hasTime: boolean): string {
  const n = c.accounts.length;
  const list = c.accounts.slice(0, 6).join(", ") + (n > 6 ? ` and ${n - 6} other accounts` : "");
  const period = hasTime ? ` between ${fmtDate(c.firstTs)} and ${fmtDate(c.lastTs)} UTC` : "";
  const cyc = c.patterns.includes("Cycle");
  const fo = c.patterns.includes("Fan-out");
  const fi = c.patterns.includes("Fan-in");
  const pt = c.patterns.includes("Pass-through");

  const why: string[] = [];
  if (cyc)
    why.push(
      "The same value circulates between related parties and returns to where it began. A legitimate payment moves value to a counterparty in exchange for something; a closed loop does not. This is the hallmark of layering, the stage of money laundering in which proceeds are moved repeatedly to obscure their origin."
    );
  if (fo && fi)
    why.push("Funds were split across many accounts in a short burst and then gathered into a single account, a scatter-gather pattern used to break a large sum into amounts that attract less attention.");
  else if (fo) why.push("One account distributed funds to many recipients within hours, a pattern consistent with breaking up a large sum.");
  else if (fi) why.push("Many accounts sent funds into one account within hours, a pattern consistent with consolidating proceeds.");
  if (pt)
    why.push(
      `Intermediary accounts forwarded about ${Math.round(c.retention * 100)}% of what they received within ${PASS_HOURS} hours, holding the money only briefly. Accounts that behave as conduits rather than genuine users are a common sign of mule activity.`
    );
  why.push(
    `Individual transfers ranged from ${usd(c.minTransfer)} to ${usd(c.maxTransfer)} and were closely sized, which is consistent with deliberate structuring rather than ordinary commerce.`
  );

  return [
    `SUBJECT & ACTIVITY SUMMARY\nAcross ${c.txCount} transactions${period}, ${n} linked accounts (${list}) moved ${usd(
      c.volume
    )} in a ${c.topology.toLowerCase()} pattern (cluster ${c.id}). The activity completed within ${fmtDur(c.hours)} and shows no identifiable goods, services or lawful business purpose.`,
    `WHY THIS PATTERN IS SUSPICIOUS\n${why.join(" ")}`,
    `POTENTIAL LEGAL EXPOSURE\nThe activity is consistent with conduct prohibited by the money laundering statute, 18 U.S.C. § 1956, which criminalizes conducting financial transactions to conceal the nature, source or ownership of criminal proceeds. Patterns designed to avoid reporting thresholds may also implicate 31 U.S.C. § 5324 (structuring). Failure to report such activity may breach the institution's obligations under the Bank Secrecy Act.`,
    `RECOMMENDED ACTION\nFile a Suspicious Activity Report, apply enhanced due diligence to all ${n} accounts, preserve transaction records, and escalate to the BSA/AML Officer to review account restrictions. Do not notify the account holders.`,
    `Note: This narrative was drafted by Aegis AI from graph analysis (risk score ${c.risk}/100). It is not a legal conclusion and must be reviewed and approved by a qualified compliance officer before filing.`,
  ].join("\n\n");
}

/* ------------------------------- Demo dataset ------------------------------ */

function makeDemoCSV(): string {
  const rnd = mulberry32(7);
  const base = Date.UTC(2026, 9, 1);
  type Row = [string, string, number, number, number];
  const rows: Row[] = [];

  // Ordinary activity: money only flows "forward" between accounts, so it never loops
  for (let i = 0; i < 900; i++) {
    const a = Math.floor(rnd() * 139);
    const b = a + 1 + Math.floor(rnd() * (139 - a));
    rows.push([`ACC-${1000 + a}`, `ACC-${1000 + b}`, Math.round((50 + rnd() * rnd() * 9000) * 100) / 100, base + rnd() * 28 * 24 * HOUR, 0]);
  }

  // Circular layering rings (funds loop back, ~1.5% skimmed per hop)
  const rings = [
    { ids: [9101, 9102, 9103, 9104, 9105], amt: 462_000, hop: 13, start: 12 * 24 + 3, entry: 1010, exit: 1130 },
    { ids: [9201, 9202, 9203, 9204], amt: 285_000, hop: 11, start: 17 * 24 + 8, entry: 1022, exit: 1121 },
    { ids: [9301, 9302, 9303], amt: 262_000, hop: 10, start: 21 * 24 + 15, entry: 1040, exit: 1100 },
  ];
  for (const r of rings) {
    const n = r.ids.length;
    rows.push([`ACC-${r.entry}`, `ACC-${r.ids[0]}`, r.amt * 1.02, base + (r.start - 6) * HOUR, 0]);
    for (let j = 0; j < n; j++)
      rows.push([`ACC-${r.ids[j]}`, `ACC-${r.ids[(j + 1) % n]}`, Math.round(r.amt * (1 - 0.015 * j)), base + (r.start + j * r.hop) * HOUR, 1]);
    rows.push([`ACC-${r.ids[2 % n]}`, `ACC-${r.exit}`, r.amt * 0.05, base + (r.start + n * r.hop + 4) * HOUR, 0]);
  }

  // Scatter-gather: one hub splits funds across 8 mules, who forward to one collector
  const hub = 9401;
  const collector = 9420;
  const t0 = 8 * 24 + 2;
  rows.push(["ACC-1015", `ACC-${hub}`, 300_000, base + t0 * HOUR, 0]);
  for (let i = 0; i < 8; i++) {
    const mule = 9411 + i;
    rows.push([`ACC-${hub}`, `ACC-${mule}`, 37_500, base + (t0 + 3 + i * 0.5) * HOUR, 1]);
    rows.push([`ACC-${mule}`, `ACC-${collector}`, 36_900, base + (t0 + 7 + i * 0.5) * HOUR, 1]);
  }
  rows.push([`ACC-${collector}`, "ACC-1135", 250_000, base + (t0 + 20) * HOUR, 0]);

  // Rapid pass-through chain (no loop): each account forwards ~99% within 4 hours
  const chain = [9501, 9502, 9503, 9504, 9505];
  const c0 = 24 * 24 + 5;
  rows.push(["ACC-1050", `ACC-${chain[0]}`, 150_000, base + c0 * HOUR, 0]);
  for (let j = 0; j < chain.length - 1; j++)
    rows.push([`ACC-${chain[j]}`, `ACC-${chain[j + 1]}`, Math.round(150_000 * 0.99 ** (j + 1)), base + (c0 + 3 + j * 4) * HOUR, 1]);
  rows.push([`ACC-${chain[4]}`, "ACC-1139", 100_000, base + (c0 + 26) * HOUR, 0]);

  // Legitimate look-alikes: a merchant paid by many customers, a refund pair, and a very slow 3-way loop
  for (let i = 0; i < 6; i++) rows.push([`ACC-${1060 + i}`, "ACC-4001", 40 + i * 13, base + (14 * 24 + 9 + i * 2) * HOUR, 0]);
  rows.push(["ACC-2001", "ACC-2002", 340, base + 5 * 24 * HOUR, 0], ["ACC-2002", "ACC-2001", 340, base + 6 * 24 * HOUR, 0]);
  rows.push(["ACC-3001", "ACC-3002", 1200, base + 2 * 24 * HOUR, 0], ["ACC-3002", "ACC-3003", 1200, base + 12 * 24 * HOUR, 0], ["ACC-3003", "ACC-3001", 1200, base + 22 * 24 * HOUR, 0]);

  rows.sort((a, b) => a[3] - b[3]);
  const lines = ["sender,receiver,amount,timestamp,is_suspicious"];
  for (const [f, t, a, ts, l] of rows) lines.push(`${f},${t},${Math.round(a * 100) / 100},${new Date(ts).toISOString()},${l}`);
  return lines.join("\n");
}

/* ========================== LOGIC END (pure, testable) ========================== */

const STAGES = ["Parsing transactions", "Building account graph", "Detecting suspicious patterns", "Scoring risk & drafting evidence"];
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
          <span className="ml-3 text-sm text-slate-500">aegis · live topology preview</span>
        </div>
        <div className="bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:28px_28px]">
          <svg viewBox="0 0 520 420" className="block h-auto w-full" role="img" aria-label="Illustration of a laundering ring hidden inside a transaction network">
            <defs>
              <marker id="hero-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="#fb7185" />
              </marker>
              <filter id="hero-glow" filterUnits="userSpaceOnUse" x="-50" y="-50" width="620" height="520">
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

      <div className="absolute -left-3 top-16 hidden items-center gap-2 rounded-full border border-emerald-400/30 bg-slate-950/90 px-3 py-1.5 text-sm text-emerald-200 shadow-[0_0_20px_rgba(16,185,129,0.25)] sm:flex">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        Scanning transaction graph…
      </div>
      <div className="absolute -bottom-4 right-2 rounded-xl border border-rose-400/40 bg-slate-950/95 px-4 py-3 shadow-[0_0_30px_rgba(244,63,94,0.3)] sm:right-6">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5" /> Laundering ring detected
        </p>
        <p className="mt-1 text-sm text-slate-400">Circular layering loop · 5 accounts</p>
        <p className="mt-1 text-base font-semibold tabular-nums text-white">Risk 94/100 · $2.3M</p>
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
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
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
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-300">
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
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-3 text-base font-semibold text-slate-950 shadow-[0_0_28px_rgba(16,185,129,0.4)] transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" />
              Try the demo dataset
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={onBrowse}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-5 py-3 text-base font-medium text-slate-100 transition hover:border-emerald-400/50 hover:bg-slate-800 disabled:opacity-60"
            >
              <Upload className="h-4 w-4" />
              Upload your CSV
            </button>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-base text-slate-400">
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
                <p className="mt-1 text-base text-slate-400">
                  Accepts <code className="text-emerald-300">.csv</code> with columns <code className="text-emerald-300">sender, receiver, amount, timestamp</code>, plus an optional <code className="text-emerald-300">is_suspicious</code> label
                </p>
                <button onClick={onSample} className="mt-2 text-sm text-slate-500 underline-offset-4 transition hover:text-slate-300 hover:underline">
                  Download a sample CSV to see the format
                </button>
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm leading-relaxed text-slate-400">
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
            <div role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-base text-rose-200">
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
              <span className="absolute right-4 top-4 text-base font-semibold text-slate-700">0{i + 1}</span>
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${tone}`}>
                <Icon className="h-5 w-5" />
              </span>
              <p className="mt-4 font-semibold text-white">{title}</p>
              <p className="mt-1 text-base leading-relaxed text-slate-400">{text}</p>
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
                <p className="mt-1 text-base leading-relaxed text-slate-400">{t.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------- Page ---------------------------------- */

const PANEL = "rounded-2xl border border-slate-800 bg-slate-900/70 shadow-[0_0_40px_rgba(2,6,23,0.5)]";
const SELECT =
  "rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-base text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400";
const BTN_GHOST =
  "inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-base font-medium text-slate-100 transition hover:border-emerald-400/50 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50";

function riskTone(r: number) {
  if (r >= 80) return { text: "text-rose-300", bar: "bg-rose-500", chip: "border-rose-400/40 bg-rose-500/15 text-rose-300", label: "Critical" };
  if (r >= 60) return { text: "text-amber-300", bar: "bg-amber-400", chip: "border-amber-400/40 bg-amber-500/15 text-amber-300", label: "High" };
  return { text: "text-sky-300", bar: "bg-sky-400", chip: "border-sky-400/40 bg-sky-500/15 text-sky-300", label: "Medium" };
}

const ROLE_CHIP: Record<string, string> = {
  "Cycle member": "border-rose-400/40 bg-rose-500/10 text-rose-200",
  "Fan-out hub": "border-amber-400/40 bg-amber-500/10 text-amber-200",
  "Fan-in hub": "border-amber-400/40 bg-amber-500/10 text-amber-200",
  "Pass-through": "border-sky-400/40 bg-sky-500/10 text-sky-200",
  Counterparty: "border-slate-600 bg-slate-800 text-slate-300",
};

const TABS = [
  { key: "explain", label: "Risk explanation", Icon: ShieldCheck },
  { key: "trail", label: "Money trail", Icon: GitBranch },
  { key: "sar", label: "SAR narrative", Icon: FileText },
  { key: "eval", label: "Evaluation", Icon: BarChart3 },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [hasTime, setHasTime] = useState(true);
  const [hasLabels, setHasLabels] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [fileName, setFileName] = useState("");
  const [params, setParams] = useState<Params>({ windowH: 168, minSize: 3, fanK: 5, minRisk: 0 });
  const [stage, setStage] = useState(-1);
  const [error, setError] = useState("");
  const [scanMsg, setScanMsg] = useState("");
  const [dragging, setDragging] = useState(false);

  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<TabKey>("explain");
  const [focus, setFocus] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [threshold, setThreshold] = useState(10_000);
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
      return { analysis: null as Analysis | null, err: "This graph is too large or deep to analyse in the browser. Try a smaller file." };
    }
  }, [txns, params]);
  const analysis = result.analysis;

  const cluster = analysis && analysis.rings.length ? analysis.rings[Math.min(selected, analysis.rings.length - 1)] : null;
  const cIdx = cluster && analysis ? analysis.rings.indexOf(cluster) : -1;
  const narrative = useMemo(() => (cluster ? buildNarrative(cluster, hasTime) : ""), [cluster, hasTime]);
  const nodeMap = useMemo(() => new Map((analysis?.nodes ?? []).map((n) => [n.id, n])), [analysis]);

  const acctStats = useMemo(() => {
    if (!cluster) return [];
    return cluster.accounts.map((a) => {
      let recv = 0;
      let sent = 0;
      for (const t of cluster.txns) {
        if (t.to === a) recv += t.amount;
        if (t.from === a) sent += t.amount;
      }
      return { a, roles: cluster.roles[a] ?? [], recv, sent };
    });
  }, [cluster]);

  const ledger = useMemo(() => (cluster ? cluster.txns.filter((t) => !focus || t.from === focus || t.to === focus) : []), [cluster, focus]);

  const evalRes = useMemo(() => {
    if (!txns || !hasLabels || !analysis) return null;
    return evaluate(txns, new Set(analysis.rings.flatMap((r) => r.accounts)), threshold);
  }, [txns, hasLabels, analysis, threshold]);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(m.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    setTyped(0);
    setGenerating(false);
    setGenerated(false);
    setFocus(null);
    setShowAll(false);
  }, [analysis, cIdx]);
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
    const id = setTimeout(() => setScanMsg(""), 7000);
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
      setHasLabels(parsed.hasLabels);
      setSkipped(parsed.skipped);
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

  const lastAnalysis = useRef<Analysis | null>(null);
  useEffect(() => {
    if (analysis && analysis !== lastAnalysis.current && !busy) {
      lastAnalysis.current = analysis;
      setScanMsg(
        analysis.rings.length
          ? `Analysis complete in ${analysis.ms} ms · ${analysis.rings.length} suspicious cluster${analysis.rings.length > 1 ? "s" : ""} detected`
          : `Analysis complete in ${analysis.ms} ms · nothing suspicious found with these settings`
      );
    }
  }, [analysis, busy]);

  const rescan = async () => {
    await runStages();
    if (analysis) setScanMsg(`Rescan complete · ${analysis.rings.length} cluster${analysis.rings.length === 1 ? "" : "s"} confirmed`);
  };

  const backToStart = () => {
    setTxns(null);
    setFileName("");
    setError("");
    setScanMsg("");
    lastAnalysis.current = null;
  };

  const startGenerate = () => {
    if (!cluster) return;
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
    if (!cluster) return;
    downloadText(
      `SAR-${cluster.id}.txt`,
      `PROJECT AEGIS - SUSPICIOUS ACTIVITY REPORT (DRAFT)\nSource file: ${fileName}\nGenerated: ${new Date().toISOString()}\n\n${narrative}`
    );
  };

  const exportAll = () => {
    if (!analysis || !analysis.rings.length) return;
    const summary = analysis.rings
      .map((r) => `${r.id}  risk ${r.risk}/100  ${r.topology}  ${r.accounts.length} accounts  ${usd(r.volume)}`)
      .join("\n");
    const body = analysis.rings
      .map((r) => `==== ${r.id} (risk ${r.risk}/100) ====\n\n${buildNarrative(r, hasTime)}`)
      .join("\n\n\n");
    downloadText(
      "SAR-report-all-clusters.txt",
      `PROJECT AEGIS - INVESTIGATION REPORT (DRAFT)\nSource file: ${fileName}\nGenerated: ${new Date().toISOString()}\nClusters detected: ${analysis.rings.length}\n\nRANKED SUMMARY\n${summary}\n\n\n${body}`
    );
  };

  const metrics = [
    {
      label: "Total Transactions Scanned",
      value: analysis ? analysis.txCount.toLocaleString("en-US") : "—",
      sub: analysis ? `${analysis.accountCount.toLocaleString("en-US")} accounts · ${usdShort(analysis.totalVolume)} total volume` : "",
      Icon: Database,
      hov: "hover:border-sky-400/50 hover:shadow-sky-500/20",
      icon: "text-sky-300 bg-sky-500/10 ring-sky-400/20",
      bar: "bg-sky-400",
    },
    {
      label: "High-Risk Laundering Rings",
      value: analysis ? `${analysis.rings.length} Active Cluster${analysis.rings.length === 1 ? "" : "s"}` : "—",
      sub: analysis ? `${analysis.rings.reduce((s, r) => s + r.accounts.length, 0)} accounts involved` : "",
      Icon: Network,
      hov: "hover:border-rose-400/50 hover:shadow-rose-500/25",
      icon: "text-rose-300 bg-rose-500/10 ring-rose-400/20",
      bar: "bg-rose-400",
    },
    {
      label: "Suspicious Volume Flagged",
      value: analysis ? usdShort(analysis.flaggedVolume) : "—",
      sub: analysis ? `${analysis.totalVolume > 0 ? ((analysis.flaggedVolume / analysis.totalVolume) * 100).toFixed(1) : 0}% of total volume` : "",
      Icon: DollarSign,
      hov: "hover:border-amber-400/50 hover:shadow-amber-500/20",
      icon: "text-amber-300 bg-amber-500/10 ring-amber-400/20",
      bar: "bg-amber-400",
    },
    {
      label: "System Risk Index",
      value: analysis ? `${analysis.riskLabel} / ${analysis.riskIndex}%` : "—",
      sub: analysis ? (analysis.riskIndex >= 60 ? "Escalation recommended" : "No escalation needed") : "",
      Icon: Gauge,
      hov: "hover:border-rose-400/60 hover:shadow-rose-500/30",
      icon: "text-rose-300 bg-rose-500/10 ring-rose-400/30",
      bar: "bg-rose-500",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-950 text-base text-slate-100 selection:bg-emerald-500/30">
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

      <div className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-10">
        {/* ------------------------------ Header ------------------------------ */}
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30 shadow-[0_0_24px_rgba(16,185,129,0.25)]">
              <ShieldCheck className="h-7 w-7 text-emerald-300" />
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-bold tracking-[0.18em] text-white">PROJECT AEGIS</h1>
              <p className="text-base text-slate-400">AML Financial Intelligence Engine · Layered laundering network detection</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="flex items-center gap-2 whitespace-nowrap rounded-full border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-base font-medium text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.25)]"
              role="status"
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
              </span>
              AI Engine Active
            </div>
            <button onClick={rescan} disabled={busy || !txns} className={BTN_GHOST}>
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Radar className="h-5 w-5 text-emerald-300" />}
              {busy ? "Scanning…" : "Scan Network"}
            </button>
            <button
              onClick={exportAll}
              disabled={!analysis || analysis.rings.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2.5 text-base font-semibold text-white shadow-[0_0_20px_rgba(244,63,94,0.35)] transition hover:bg-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Download className="h-5 w-5" />
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
            <section aria-label="Key metrics" className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {metrics.map(({ label, value, sub, Icon, hov, icon, bar }, i) => (
                <div
                  key={label}
                  className={`group relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-6 backdrop-blur transition duration-300 hover:-translate-y-0.5 hover:shadow-xl ${hov}`}
                >
                  <div className={`absolute inset-x-0 top-0 h-px ${bar} opacity-60`} />
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-base font-medium text-slate-400">{label}</p>
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${icon}`}>
                      <Icon className="h-5 w-5" />
                    </span>
                  </div>
                  <p className="mt-4 text-4xl font-semibold tabular-nums tracking-tight text-white">{value}</p>
                  <p className="mt-1 min-h-[1.5rem] text-base text-slate-500">{sub}</p>
                  {i === 3 && (
                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
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

            {/* ------------------------- Data source & filters ------------------------- */}
            <section className={`${PANEL} mt-6 p-5`} aria-label="Data source and detection settings">
              <div className="flex flex-wrap items-center justify-between gap-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30">
                    <FileSpreadsheet className="h-5 w-5 text-emerald-300" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold text-white">{fileName}</p>
                    <p className="text-base text-slate-400">
                      {analysis ? `${analysis.txCount.toLocaleString("en-US")} valid transactions` : "Loaded"}
                      {skipped > 0 ? ` · ${skipped} invalid rows skipped` : ""}
                      {hasLabels ? " · labels detected" : ""}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-4">
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-400">
                    Loop time window
                    <select value={params.windowH} onChange={(e) => setParams((p) => ({ ...p, windowH: Number(e.target.value) }))} className={SELECT}>
                      {WINDOWS.map((w) => (
                        <option key={w.h} value={w.h}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-400">
                    Min loop size
                    <select value={params.minSize} onChange={(e) => setParams((p) => ({ ...p, minSize: Number(e.target.value) }))} className={SELECT}>
                      {[3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n} accounts
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-400">
                    Fan-out / fan-in threshold
                    <select value={params.fanK} onChange={(e) => setParams((p) => ({ ...p, fanK: Number(e.target.value) }))} className={SELECT}>
                      {[4, 5, 8].map((n) => (
                        <option key={n} value={n}>
                          {n}+ counterparties
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-slate-400">
                    Minimum risk score
                    <select value={params.minRisk} onChange={(e) => setParams((p) => ({ ...p, minRisk: Number(e.target.value) }))} className={SELECT}>
                      {[0, 60, 70, 80, 90].map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? "Show all" : `${n}+`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => fileRef.current?.click()} disabled={busy} className={BTN_GHOST}>
                    <Upload className="h-5 w-5" />
                    Replace file
                  </button>
                  <button onClick={backToStart} disabled={busy} className={BTN_GHOST}>
                    <ArrowLeft className="h-5 w-5" />
                    Start over
                  </button>
                </div>
              </div>
              {busy && (
                <div className="mt-5">
                  <PipelineStrip stage={stage} />
                </div>
              )}
              {(error || result.err) && (
                <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-base text-rose-200">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  {error || result.err}
                </div>
              )}
            </section>

            {/* --------------------------- Graph + ranked list --------------------------- */}
            <section className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
              <div className={`${PANEL} flex min-w-0 flex-col xl:col-span-2`}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-5">
                  <div className="flex items-center gap-3">
                    <Activity className="h-6 w-6 text-emerald-300" />
                    <h2 className="text-xl font-semibold text-white">Live Transaction Topology &amp; Ring Detection</h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-300">
                    <span className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                      Normal account
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e]" />
                      Flagged account
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-px w-5 border-t border-dashed border-slate-400" />
                      Link to cluster
                    </span>
                  </div>
                </div>

                <div className="flex-1 p-4 sm:p-6">
                  <div
                    className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950 bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:32px_32px]"
                    style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
                  >
                    {analysis && (
                      <svg
                        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
                        className="absolute inset-0 block h-full w-full"
                        role="img"
                        aria-label="Transaction network graph with suspicious clusters highlighted"
                      >
                        <defs>
                          <marker id="arrow-rose" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M0 0 L10 5 L0 10 z" fill="#fb7185" />
                          </marker>
                          <filter id="glow" filterUnits="userSpaceOnUse" x="-50" y="-50" width={CANVAS_W + 100} height={CANVAS_H + 100}>
                            <feGaussianBlur stdDeviation="4" result="b" />
                            <feMerge>
                              <feMergeNode in="b" />
                              <feMergeNode in="SourceGraphic" />
                            </feMerge>
                          </filter>
                        </defs>

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
                                strokeWidth={1.3}
                              />
                            );
                          })}

                        {Array.from({ length: analysis.shown }).map((_, ci) => {
                          const r = analysis.rings[ci];
                          const active = ci === cIdx;
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
                              <title>{`${r.id} · ${r.topology} · click to select`}</title>
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
                                      {animate && <animate attributeName="stroke-dashoffset" from="20" to="0" dur="1.2s" repeatCount="indefinite" />}
                                    </line>
                                  );
                                })}
                              {members.map((n) => (
                                <g
                                  key={n.id}
                                  onClick={(e) => {
                                    if (!active) return;
                                    e.stopPropagation();
                                    setFocus((f) => (f === n.id ? null : n.id));
                                    setTab("trail");
                                  }}
                                >
                                  <title>{`${n.id} · ${(r.roles[n.id] ?? []).join(", ")}`}</title>
                                  {animate && (
                                    <circle cx={n.x} cy={n.y} r={14} fill="none" stroke="#f43f5e" strokeOpacity={0.5}>
                                      <animate attributeName="r" values="12;24;12" dur="2.4s" repeatCount="indefinite" />
                                      <animate attributeName="stroke-opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite" />
                                    </circle>
                                  )}
                                  {focus === n.id && <circle cx={n.x} cy={n.y} r={19} fill="none" stroke="#fbbf24" strokeWidth={3} />}
                                  <circle cx={n.x} cy={n.y} r={11} fill="#f43f5e" stroke="#fecdd3" strokeWidth={1.5} filter="url(#glow)" />
                                  {active && (
                                    <text x={n.x} y={n.y + (n.y > cy ? 28 : -20)} textAnchor="middle" className="fill-slate-200 text-[12px]">
                                      {n.id.length > 12 ? n.id.slice(0, 12) : n.id}
                                    </text>
                                  )}
                                </g>
                              ))}
                              <text x={cx} y={cy + 5} textAnchor="middle" className="fill-rose-200 text-[15px] font-semibold">
                                {r.id}
                              </text>
                            </g>
                          );
                        })}

                        {analysis.nodes
                          .filter((n) => n.ring < 0)
                          .map((n) => (
                            <circle key={n.id} cx={n.x} cy={n.y} r={7} fill="#10b981" stroke="#a7f3d0" strokeWidth={1.2} filter="url(#glow)">
                              <title>{n.id}</title>
                            </circle>
                          ))}

                        {busy && (
                          <rect x="0" y="0" width={CANVAS_W} height="3" fill="#34d399" opacity="0.7">
                            <animate attributeName="y" from="0" to={CANVAS_H} dur="1.3s" repeatCount="indefinite" />
                          </rect>
                        )}
                      </svg>
                    )}
                  </div>
                  <p className="mt-3 min-h-[1.75rem] text-base text-emerald-300/90" role="status" aria-live="polite">
                    {busy ? STAGES[stage] + "…" : scanMsg || (cluster ? "Tip: click a red account in the selected cluster to follow its money trail." : "")}
                  </p>
                </div>
              </div>

              {/* Ranked clusters */}
              <aside className={`${PANEL} flex min-w-0 flex-col`}>
                <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-6 py-5">
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-6 w-6 text-rose-300" />
                    <h2 className="text-xl font-semibold text-white">Ranked Clusters</h2>
                  </div>
                  <span className="text-base text-slate-400">{analysis ? analysis.rings.length : 0} found</span>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto p-4 xl:max-h-[700px]">
                  {analysis && analysis.rings.length > 0 ? (
                    analysis.rings.map((c, i) => {
                      const tone = riskTone(c.risk);
                      return (
                        <button
                          key={c.id}
                          onClick={() => setSelected(i)}
                          aria-pressed={i === cIdx}
                          className={`w-full rounded-xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
                            i === cIdx
                              ? "border-rose-400/60 bg-rose-500/10 shadow-[0_0_20px_rgba(244,63,94,0.2)]"
                              : "border-slate-800 bg-slate-950/60 hover:border-slate-600"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex items-center gap-2 text-lg font-semibold text-white">
                              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-800 text-sm text-slate-300">{i + 1}</span>
                              {c.id}
                            </span>
                            <span className={`whitespace-nowrap rounded-full border px-3 py-1 text-sm font-semibold ${tone.chip}`}>
                              {tone.label} · {c.risk}
                            </span>
                          </div>
                          <p className="mt-2 text-base text-slate-200">{c.topology}</p>
                          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                            <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${c.risk}%` }} />
                          </div>
                          <p className="mt-3 text-base text-slate-400">
                            {c.accounts.length} accounts · {usd(c.volume)} · {c.hours < 1 ? "<1h" : fmtDur(c.hours)}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {c.patterns.map((p) => (
                              <span key={p} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-sm text-slate-300">
                                {p}
                              </span>
                            ))}
                            {i >= (analysis?.shown ?? 0) && <span className="rounded-md border border-slate-700 px-2 py-0.5 text-sm text-slate-500">not drawn</span>}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-6 text-center">
                      <ShieldCheck className="h-8 w-8 text-emerald-300" />
                      <p className="mt-3 text-lg font-semibold text-emerald-100">No suspicious clusters</p>
                      <p className="mt-1 text-base text-emerald-200/80">Try a wider time window, a lower fan threshold or a smaller minimum loop size.</p>
                    </div>
                  )}
                </div>
              </aside>
            </section>

            {/* ------------------------------ Investigation ------------------------------ */}
            <section className={`${PANEL} mt-6`} aria-label="Investigation workspace">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-6 pt-5">
                <div className="pb-4">
                  <h2 className="text-xl font-semibold text-white">Investigation Workspace</h2>
                  <p className="text-base text-slate-400">
                    {cluster ? `${cluster.id} · ${cluster.topology}` : "Select a cluster to investigate"}
                  </p>
                </div>
                <div role="tablist" aria-label="Investigation views" className="flex flex-wrap gap-1">
                  {TABS.map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={tab === key}
                      onClick={() => setTab(key)}
                      className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-3 text-base font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                        tab === key ? "border-emerald-400 text-emerald-300" : "border-transparent text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-6">
                {/* ---- Risk explanation ---- */}
                {tab === "explain" &&
                  (cluster ? (
                    <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6">
                        <p className="text-base text-slate-400">Risk score</p>
                        <p className={`mt-1 text-7xl font-bold tabular-nums ${riskTone(cluster.risk).text}`}>
                          {cluster.risk}
                          <span className="text-2xl font-medium text-slate-500">/100</span>
                        </p>
                        <p className={`mt-1 text-lg font-semibold ${riskTone(cluster.risk).text}`}>{riskTone(cluster.risk).label} risk</p>
                        <dl className="mt-5 grid grid-cols-2 gap-4">
                          {[
                            ["Accounts", String(cluster.accounts.length)],
                            ["Volume", usd(cluster.volume)],
                            ["Duration", cluster.hours < 1 ? "<1h" : fmtDur(cluster.hours)],
                            ["Transfers", String(cluster.txCount)],
                          ].map(([k, v]) => (
                            <div key={k}>
                              <dt className="text-sm text-slate-500">{k}</dt>
                              <dd className="text-lg font-semibold tabular-nums text-slate-100">{v}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="mt-5 flex flex-wrap gap-2">
                          {cluster.patterns.map((p) => (
                            <span key={p} className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 text-sm text-rose-200">
                              {p}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <h3 className="text-lg font-semibold text-white">Why this score? Every point is explained</h3>
                        <ul className="mt-4 space-y-5">
                          {cluster.factors.map((f) => (
                            <li key={f.label}>
                              <div className="flex items-baseline justify-between gap-4">
                                <span className="text-base font-medium text-slate-100">{f.label}</span>
                                <span className="text-base tabular-nums text-slate-300">
                                  {f.pts} <span className="text-slate-500">/ {f.max}</span>
                                </span>
                              </div>
                              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                                <div className={`h-full rounded-full ${riskTone(cluster.risk).bar}`} style={{ width: `${(f.pts / f.max) * 100}%` }} />
                              </div>
                              <p className="mt-1.5 text-base text-slate-400">{f.note}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : (
                    <p className="py-10 text-center text-lg text-slate-500">No cluster selected.</p>
                  ))}

                {/* ---- Money trail ---- */}
                {tab === "trail" &&
                  (cluster ? (
                    <div className="space-y-8">
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <h3 className="text-lg font-semibold text-white">Accounts in {cluster.id}</h3>
                          <p className="text-base text-slate-400">Select an account to follow its money; it is also highlighted on the graph.</p>
                        </div>
                        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
                          <table className="w-full min-w-[640px] text-left text-base">
                            <thead className="bg-slate-950/80 text-sm uppercase tracking-wider text-slate-400">
                              <tr>
                                <th className="px-4 py-3">Account</th>
                                <th className="px-4 py-3">Role</th>
                                <th className="px-4 py-3 text-right">Received</th>
                                <th className="px-4 py-3 text-right">Sent</th>
                                <th className="px-4 py-3 text-right">Forwarded</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {acctStats.map((s) => (
                                <tr
                                  key={s.a}
                                  onClick={() => setFocus((f) => (f === s.a ? null : s.a))}
                                  className={`cursor-pointer transition hover:bg-slate-800/60 ${focus === s.a ? "bg-amber-500/10" : ""}`}
                                >
                                  <td className="px-4 py-3 font-medium text-white">{s.a}</td>
                                  <td className="px-4 py-3">
                                    <div className="flex flex-wrap gap-2">
                                      {s.roles.map((r) => (
                                        <span key={r} className={`rounded-md border px-2 py-0.5 text-sm ${ROLE_CHIP[r] ?? ROLE_CHIP.Counterparty}`}>
                                          {r}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-right tabular-nums text-slate-200">{usd(s.recv)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-slate-200">{usd(s.sent)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-slate-300">{s.recv > 0 ? pct(s.sent / s.recv) : "origin"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <h3 className="text-lg font-semibold text-white">
                            Transfer ledger{focus ? ` for ${focus}` : ""} <span className="text-slate-500">({ledger.length})</span>
                          </h3>
                          {focus && (
                            <button onClick={() => setFocus(null)} className="text-base text-emerald-300 underline-offset-4 hover:underline">
                              Clear account filter
                            </button>
                          )}
                        </div>
                        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
                          <table className="w-full min-w-[640px] text-left text-base">
                            <thead className="bg-slate-950/80 text-sm uppercase tracking-wider text-slate-400">
                              <tr>
                                <th className="px-4 py-3">#</th>
                                <th className="px-4 py-3">{hasTime ? "Time (UTC)" : "Order"}</th>
                                <th className="px-4 py-3">From</th>
                                <th className="px-4 py-3">To</th>
                                <th className="px-4 py-3 text-right">Amount</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {(showAll ? ledger : ledger.slice(0, 12)).map((t, i) => (
                                <tr key={i} className="hover:bg-slate-800/40">
                                  <td className="px-4 py-3 text-slate-500">{i + 1}</td>
                                  <td className="px-4 py-3 tabular-nums text-slate-300">{hasTime ? fmtDate(t.t) : `row ${i + 1}`}</td>
                                  <td className="px-4 py-3 text-slate-100">{t.from}</td>
                                  <td className="px-4 py-3 text-slate-100">{t.to}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-slate-100">{usd(t.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {ledger.length > 12 && (
                          <button onClick={() => setShowAll((v) => !v)} className="mt-3 text-base text-emerald-300 underline-offset-4 hover:underline">
                            {showAll ? "Show fewer" : `Show all ${ledger.length} transfers`}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="py-10 text-center text-lg text-slate-500">No cluster selected.</p>
                  ))}

                {/* ---- SAR narrative ---- */}
                {tab === "sar" && (
                  <div className="mx-auto max-w-4xl">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <button
                        onClick={startGenerate}
                        disabled={generating || !cluster}
                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-5 py-3 text-base font-semibold text-emerald-200 transition hover:bg-emerald-500/20 hover:shadow-[0_0_20px_rgba(16,185,129,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {generating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
                        {generating ? "Drafting narrative…" : generated ? "Regenerate narrative" : "Generate SAR narrative"}
                      </button>
                      <div className="flex gap-3">
                        <button onClick={copyNarrative} disabled={!generated} className={BTN_GHOST}>
                          {copied ? <Check className="h-5 w-5 text-emerald-300" /> : <Copy className="h-5 w-5" />}
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <button
                          onClick={exportOne}
                          disabled={!generated}
                          className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Download className="h-5 w-5" />
                          Export
                        </button>
                      </div>
                    </div>
                    <div className="mt-5 min-h-[320px] rounded-xl border border-slate-800 bg-slate-950 p-6 text-lg leading-8 text-slate-200" aria-live="polite">
                      {blocks.length > 0 ? (
                        <div className="space-y-6">
                          {blocks.map((b, i) => {
                            const [head, ...rest] = b.split("\n");
                            const isHeading = /^[A-Z &]{6,}$/.test(head);
                            const isLast = i === blocks.length - 1;
                            const cursor = generating && isLast && <span className="ml-0.5 inline-block h-5 w-2 translate-y-0.5 animate-pulse bg-emerald-400" />;
                            return isHeading ? (
                              <div key={i}>
                                <h3 className="mb-2 text-base font-semibold tracking-wider text-emerald-300">{head}</h3>
                                <p>
                                  {rest.join("\n")}
                                  {cursor}
                                </p>
                              </div>
                            ) : (
                              <p key={i} className="text-base italic text-slate-500">
                                {b}
                                {cursor}
                              </p>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 ring-1 ring-slate-700">
                            <FileText className="h-6 w-6 text-slate-500" />
                          </span>
                          <p className="mt-4 text-xl font-medium text-slate-200">{cluster ? "No narrative drafted yet" : "No cluster selected"}</p>
                          <p className="mt-1 max-w-md text-base text-slate-500">
                            {cluster ? `Generate a plain-language explanation of why ${cluster.id} is consistent with money laundering, ready for compliance review.` : "Select a cluster first."}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ---- Evaluation ---- */}
                {tab === "eval" &&
                  (evalRes ? (
                    <div className="space-y-8">
                      <div className="flex flex-wrap items-end justify-between gap-4">
                        <div className="max-w-3xl">
                          <h3 className="text-lg font-semibold text-white">Aegis vs. a simple threshold rule</h3>
                          <p className="mt-1 text-base text-slate-400">
                            Scored per account against the labelled data ({evalRes.truth} truly suspicious accounts). The baseline flags every account that touches a single transfer at or above the threshold.
                          </p>
                        </div>
                        <label className="flex flex-col gap-1 text-sm font-medium text-slate-400">
                          Baseline threshold
                          <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className={SELECT}>
                            {[5_000, 10_000, 50_000, 100_000].map((n) => (
                              <option key={n} value={n}>
                                {usd(n)}+
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div className="grid gap-6 lg:grid-cols-2">
                        {[
                          { name: "Project Aegis (graph-based)", s: evalRes.aegis, flagged: evalRes.flaggedAegis, bar: "bg-emerald-400", ring: "border-emerald-400/40" },
                          { name: `Threshold baseline (${usd(threshold)}+)`, s: evalRes.baseline, flagged: evalRes.flaggedBase, bar: "bg-slate-400", ring: "border-slate-700" },
                        ].map(({ name, s, flagged, bar, ring }) => (
                          <div key={name} className={`rounded-2xl border bg-slate-950/60 p-6 ${ring}`}>
                            <p className="text-lg font-semibold text-white">{name}</p>
                            <p className="text-base text-slate-400">{flagged} accounts flagged</p>
                            <div className="mt-5 space-y-4">
                              {[
                                ["Precision", s.precision],
                                ["Recall", s.recall],
                                ["F1 score", s.f1],
                              ].map(([label, v]) => (
                                <div key={label as string}>
                                  <div className="flex justify-between text-base">
                                    <span className="text-slate-300">{label as string}</span>
                                    <span className="font-semibold tabular-nums text-white">{pct(v as number)}</span>
                                  </div>
                                  <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-slate-800">
                                    <div className={`h-full rounded-full ${bar} transition-all duration-700`} style={{ width: pct(v as number) }} />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <p className="mt-5 text-base text-slate-400">
                              {s.tp} correct · {s.fp} false alarms · {s.fn} missed
                            </p>
                          </div>
                        ))}
                      </div>

                      <p className="rounded-xl border border-slate-800 bg-slate-950/60 px-5 py-4 text-base leading-7 text-slate-300">
                        Aegis finds {evalRes.aegis.tp} of {evalRes.truth} suspicious accounts with {evalRes.aegis.fp} false alarm{evalRes.aegis.fp === 1 ? "" : "s"}. The threshold rule finds {evalRes.baseline.tp} but raises {evalRes.baseline.fp}, and its recall falls as the threshold rises because laundering is split into smaller transfers.
                        <span className="text-slate-500"> Note: the built-in demo labels are synthetic, so these numbers show the method working, not real-world accuracy. Upload your own labelled data for a genuine evaluation.</span>
                      </p>
                    </div>
                  ) : (
                    <div className="mx-auto max-w-2xl py-8 text-center">
                      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 ring-1 ring-slate-700">
                        <BarChart3 className="h-6 w-6 text-slate-400" />
                      </span>
                      <p className="mt-4 text-xl font-semibold text-white">No ground-truth labels in this file</p>
                      <p className="mt-2 text-base leading-7 text-slate-400">
                        To measure precision, recall and F1, add a column named <code className="text-emerald-300">is_suspicious</code> (1 = laundering, 0 = normal) to your CSV and upload it again. The demo dataset already includes one.
                      </p>
                    </div>
                  ))}
              </div>
            </section>
          </>
        )}

        <footer className="mt-10 border-t border-slate-800 pt-5 text-center text-base text-slate-500">
          Project Aegis · PS 2.1 Graph-Based Detection of Layered Money Laundering Networks · Analysis runs locally in your browser
        </footer>
      </div>
    </main>
  );
}
