<div align="center">

# 🛡️ PROJECT AEGIS

### AML Financial Intelligence Engine

**Graph-based detection of layered money-laundering networks, with explainable risk scores and auto-drafted SAR reports.**

![Next.js](https://img.shields.io/badge/Next.js-App_Router-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-18+-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3+-06B6D4?logo=tailwindcss&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)
![Status](https://img.shields.io/badge/status-hackathon_prototype-f43f5e)

**Problem Statement 2.1: Graph-Based Detection of Layered Money Laundering Networks**

<p align="center">
  <a href="https://aml-financial-engine.vercel.app/" target="_blank"><b>🌐 Explore Live App</b></a> &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://1drv.ms/v/c/2E7A80FD9652DBC6/IQC2aLia4hguRZRoWVFkaYRlAa1LKPHl65fBhEKw21HGAHo?e=wLCpa4" target="_blank"><b>▶️ Watch Demo Video</b></a> &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/ChetanaR-cse/aml-financial-engine/issues">Report a Bug</a>
</p>

</div>

---

## 📖 Table of Contents

- [Why Aegis?](#-why-aegis)
- [Key Features](#-key-features)
- [How It Works](#-how-it-works)
- [Risk Scoring](#-explainable-risk-scoring)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Input Data Format](#-input-data-format)
- [Demo Walkthrough](#-demo-walkthrough)
- [Evaluation](#-evaluation)
- [Deployment](#-deployment)
- [Project Structure](#-project-structure)
- [Limitations](#-limitations)
- [Roadmap](#-roadmap)
- [Disclaimer](#-disclaimer)
- [Team](#-team)

---

## 🎯 Why Aegis?

Money launderers rarely move dirty money in a single step. They use **layering**: funds are passed through many accounts, split into smaller amounts, and looped back to the starting point so the original source is hidden.

Traditional rule-based monitoring (for example, "flag any transfer above $10,000") struggles here because:

- **Each individual transfer looks normal.** The suspicious signal exists only in the *network*.
- **Launderers deliberately split amounts** to stay below fixed thresholds.
- **Threshold rules generate many false alarms**, wasting analyst time.
- **Investigations and SAR writing are slow and manual.**

**Aegis models accounts as nodes and payments as directed, timed edges**, so laundering shows up as recognisable *shapes* in the graph rather than as isolated transactions. It then scores each suspicious cluster, explains the score, and drafts the compliance report.

---

## ✨ Key Features

| | Feature | What it does |
|---|---|---|
| 📥 | **CSV upload & validation** | Drag and drop a transaction file. Required columns are checked and invalid rows are counted and skipped. |
| 🕸️ | **Directed, weighted, temporal graph** | Accounts become nodes, payments become timed, weighted edges. |
| 🔁 | **Time-ordered cycle detection** | Finds loops where money returns to its source, and only counts them if every hop happens *after* the previous one. |
| 🌪️ | **Fan-out / fan-in detection** | Flags accounts that distribute to, or collect from, many counterparties in a short burst. |
| ⚡ | **Rapid pass-through detection** | Flags mule-like accounts that forward almost everything they receive within hours. |
| 🧩 | **Cluster formation & topology labels** | Connected suspicious accounts are grouped and labelled: circular loop, scatter-gather, fan-out, fan-in, or pass-through chain. |
| 📊 | **Explainable risk score (0–100)** | A six-factor score where every point has a stated reason. |
| 🔎 | **Money-trail explorer** | Click any account to follow its funds through a time-ordered ledger, highlighted on the graph. |
| 📝 | **SAR narrative generator** | Drafts a plain-language Suspicious Activity Report per cluster. Copy or export it. |
| 🧪 | **Evaluation panel** | Precision, recall and F1 versus a threshold-rule baseline, on labelled data. |
| 🎛️ | **Interactive filters** | Loop time window, minimum loop size, fan threshold, and minimum risk score all re-run detection instantly. |
| 🔒 | **Private by design** | The analysis engine runs entirely in the browser. Uploaded files are not sent to a server. |

---

## ⚙️ How It Works
