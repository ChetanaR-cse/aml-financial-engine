from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx

app = FastAPI(title="Project Aegis - AML Graph API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Mock dataset -------------------------------------------------------
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
    # Hidden circular laundering loop
    ("ACC-A", "ACC-B", 95000),
    ("ACC-B", "ACC-C", 93500),
    ("ACC-C", "ACC-A", 92000),
    # Normal customer activity toward a merchant
    ("ACC-D", "MERCH-1", 120),
    ("ACC-E", "MERCH-1", 45),
    ("ACC-F", "MERCH-1", 310),
    ("ACC-D", "ACC-E", 60),
    # Ring account receives funds from outside (entry point)
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