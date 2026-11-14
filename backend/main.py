import csv
import io
import os
from datetime import datetime, timedelta

import networkx as nx
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Project Aegis - AML Graph API")

# Allow the local frontend, plus a deployed frontend set via FRONTEND_URL
origins = ["http://localhost:3000"]
extra = os.getenv("FRONTEND_URL")
if extra:
    origins.append(extra)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Mock dataset (used by /api/graph) ----------------------------------
ACCOUNTS = {
    "ACC-A": "Account A",
    "ACC-B": "Account B",
    "ACC-C": "Account C",       # A -> B -> C -> A is the hidden laundering ring
    "ACC-D": "Account D",
    "ACC-E": "Account E",
    "ACC-F": "Account F",
    "MERCH-1": "Regular Merchant",
}

TRANSACTIONS = [
    ("ACC-A", "ACC-B", 95000),
    ("ACC-B", "ACC-C", 93500),
    ("ACC-C", "ACC-A", 92000),
    ("ACC-D", "MERCH-1", 120),
    ("ACC-E", "MERCH-1", 45),
    ("ACC-F", "MERCH-1", 310),
    ("ACC-D", "ACC-E", 60),
    ("ACC-F", "ACC-A", 1500),
]


def build_graph() -> nx.DiGraph:
    g = nx.DiGraph()
    for acc_id, name in ACCOUNTS.items():
        g.add_node(acc_id, label=name)
    for src, dst, amount in TRANSACTIONS:
        g.add_edge(src, dst, amount=amount)
    return g


def detect_rings(g: nx.DiGraph):
    """Find directed cycles of length >= 3 (circular fund flow)."""
    return [c for c in nx.simple_cycles(g) if len(c) >= 3]


@app.get("/")
def root():
    return {"status": "ok", "service": "Project Aegis API"}


@app.get("/api/graph")
def get_graph():
    g = build_graph()
    rings = detect_rings(g)
    ring_nodes = {n for ring in rings for n in ring}
    ring_edges = set()
    for ring in rings:
        for i, n in enumerate(ring):
            ring_edges.add((n, ring[(i + 1) % len(ring)]))

    nodes = [
        {
            "id": n,
            "label": data["label"],
            "risk": "high" if n in ring_nodes else "low",
            "in_ring": n in ring_nodes,
        }
        for n, data in g.nodes(data=True)
    ]
    edges = [
        {
            "id": f"{s}->{t}",
            "source": s,
            "target": t,
            "amount": d["amount"],
            "risk": "high" if (s, t) in ring_edges else "low",
        }
        for s, t, d in g.edges(data=True)
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "total_accounts": len(nodes),
            "total_transactions": len(edges),
            "flagged_rings": len(rings),
            "flagged_accounts": len(ring_nodes),
        },
    }


# ---- CSV analysis (used by /api/analyze) --------------------------------
SENDER_COLS = ("sender", "source", "from", "from_account", "origin")
RECEIVER_COLS = ("receiver", "target", "to", "to_account", "destination")
AMOUNT_COLS = ("amount", "value", "amt")
TIME_COLS = ("timestamp", "time", "date", "datetime")

MAX_BYTES = 10 * 1024 * 1024
MAX_RING_LEN = 8
MAX_CYCLES = 2000


def _pick(row: dict, names):
    for n in names:
        if n in row and row[n] not in (None, ""):
            return row[n].strip()
    return None


def parse_csv(text: str):
    """Return (transactions, warnings). Each tx: dict(id, src, dst, amount, ts)."""
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(400, "CSV has no header row")
    reader.fieldnames = [h.strip().lower() for h in reader.fieldnames]
    cols = set(reader.fieldnames)
    for label, names in (
        ("sender", SENDER_COLS),
        ("receiver", RECEIVER_COLS),
        ("amount", AMOUNT_COLS),
        ("timestamp", TIME_COLS),
    ):
        if not cols.intersection(names):
            raise HTTPException(
                400, f"Missing '{label}' column. Accepted names: {', '.join(names)}"
            )

    txs = []
    skipped = {"bad_amount": 0, "bad_timestamp": 0, "missing_party": 0, "self_transfer": 0}
    for i, row in enumerate(reader):
        src, dst = _pick(row, SENDER_COLS), _pick(row, RECEIVER_COLS)
        if not src or not dst:
            skipped["missing_party"] += 1
            continue
        if src == dst:
            skipped["self_transfer"] += 1
            continue
        try:
            amount = float(str(_pick(row, AMOUNT_COLS)).replace("$", "").replace(",", ""))
        except ValueError:
            skipped["bad_amount"] += 1
            continue
        try:
            ts = datetime.fromisoformat(_pick(row, TIME_COLS).replace("Z", ""))
        except (ValueError, AttributeError):
            skipped["bad_timestamp"] += 1
            continue
        txs.append({
            "id": _pick(row, ("transaction_id", "id")) or f"R{i + 1}",
            "src": src, "dst": dst, "amount": amount, "ts": ts,
        })

    warnings = [f"Skipped {n} row(s): {k.replace('_', ' ')}" for k, n in skipped.items() if n]
    return txs, warnings


def best_loop(cycle, edge_txs, window: timedelta):
    """Find the fastest chronological pass around a cycle within the window.
    Returns a list of chosen transactions (one per edge) or None."""
    n = len(cycle)
    best = None
    for rot in range(n):  # try every account as the starting point
        order = cycle[rot:] + cycle[:rot]
        pairs = [(order[i], order[(i + 1) % n]) for i in range(n)]
        for first in edge_txs[pairs[0]]:
            chosen, t = [first], first["ts"]
            ok = True
            for pair in pairs[1:]:
                nxt = next(
                    (x for x in edge_txs[pair]
                     if x["ts"] >= t and x["ts"] - first["ts"] <= window),
                    None,
                )
                if nxt is None:
                    ok = False
                    break
                chosen.append(nxt)
                t = nxt["ts"]
            if ok:
                span = chosen[-1]["ts"] - first["ts"]
                if best is None or span < best[0]:
                    best = (span, chosen)
    return best[1] if best else None


def score_ring(size: int, hours: float, volume: float) -> int:
    score = 55 + min(size, 8) * 3
    score += 20 if hours <= 12 else 10 if hours <= 48 else 5 if hours <= 168 else 0
    score += 5 if volume >= 100_000 else 0
    return min(score, 99)


def analyze(txs, window_days: int, min_ring_size: int):
    window = timedelta(days=window_days)
    g = nx.DiGraph()
    edge_txs = {}
    for tx in sorted(txs, key=lambda x: x["ts"]):
        g.add_edge(tx["src"], tx["dst"])
        edge_txs.setdefault((tx["src"], tx["dst"]), []).append(tx)

    rings, seen_tx = [], set()
    bound = max(MAX_RING_LEN, min_ring_size)
    for count, cycle in enumerate(nx.simple_cycles(g, length_bound=bound)):
        if count >= MAX_CYCLES:
            break
        if len(cycle) < min_ring_size:
            continue
        chosen = best_loop(cycle, edge_txs, window)
        if not chosen:
            continue
        volume = sum(t["amount"] for t in chosen)
        hours = (chosen[-1]["ts"] - chosen[0]["ts"]).total_seconds() / 3600
        flow = [t["src"] for t in chosen] + [chosen[0]["src"]]
        rings.append({
            "accounts": [t["src"] for t in chosen],
            "size": len(cycle),
            "volume": round(volume, 2),
            "window_hours": round(hours, 1),
            "risk_score": score_ring(len(cycle), hours, volume),
            "flow": flow,
            "transaction_ids": [t["id"] for t in chosen],
        })
        seen_tx.update(t["id"] for t in chosen)

    rings.sort(key=lambda r: (-r["risk_score"], -r["volume"]))
    for i, r in enumerate(rings, 1):
        r["id"] = f"RING-{i:03d}"
        r["pattern"] = "Rapid circular layering" if r["window_hours"] <= 12 else "Circular layering"

    ring_nodes = {a for r in rings for a in r["accounts"]}
    ring_edges = {
        (r["flow"][i], r["flow"][i + 1]) for r in rings for i in range(len(r["flow"]) - 1)
    }
    total_volume = sum(t["amount"] for t in txs)
    suspicious = sum(t["amount"] for t in txs if t["id"] in seen_tx)

    nodes = [
        {"id": n, "label": n, "risk": "high" if n in ring_nodes else "low",
         "in_ring": n in ring_nodes}
        for n in g.nodes
    ]
    edges = []
    for (s, d), items in edge_txs.items():
        edges.append({
            "id": f"{s}->{d}", "source": s, "target": d,
            "amount": round(sum(t["amount"] for t in items), 2),
            "count": len(items),
            "risk": "high" if (s, d) in ring_edges else "low",
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "rings": rings,
        "stats": {
            "total_transactions": len(txs),
            "total_accounts": len(nodes),
            "total_volume": round(total_volume, 2),
            "flagged_rings": len(rings),
            "flagged_accounts": len(ring_nodes),
            "suspicious_volume": round(suspicious, 2),
            "suspicious_pct": round(100 * suspicious / total_volume, 1) if total_volume else 0,
            "risk_index": max((r["risk_score"] for r in rings), default=0),
        },
        "settings": {"time_window_days": window_days, "min_ring_size": min_ring_size},
    }


@app.post("/api/analyze")
async def analyze_csv(
    file: UploadFile = File(...),
    time_window_days: int = Query(7, ge=1, le=365),
    min_ring_size: int = Query(3, ge=2, le=8),
):
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "File too large (max 10 MB)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(400, "File must be a UTF-8 CSV")

    txs, warnings = parse_csv(text)
    if not txs:
        raise HTTPException(400, "No valid transactions found in file")

    result = analyze(txs, time_window_days, min_ring_size)
    result["warnings"] = warnings
    return result
