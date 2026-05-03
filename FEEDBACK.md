# Developer Feedback — Uniswap AI & Developer Docs

**To:** Uniswap Labs Developer Experience Team  
**Repo:** https://github.com/Uniswap/uniswap-ai  
**Docs:** https://developers.uniswap.org/docs  
**Date:** 3 May 2026

---

## Overview

We built **UniswapSwarm** — an autonomous six-agent DeFi system that researches, plans, risk-scores, strategises, critiques, and executes token swaps across Uniswap V2/V3/V4 and UniswapX on Ethereum mainnet. The swarm runs on the 0G Compute Network for verifiable LLM inference and uses 0G Storage for on-chain audit trails.

During integration we ran into four gaps in the Uniswap developer surface that forced us to patch in third-party data providers (DeFiLlama, CoinGecko). Two of those gaps remain fully open; one is partially addressed; one is almost fully resolved by recent API additions. We document all four below in the hope they are useful to the team.

---

## Request 1 — Add a `twap-oracle` Skill and a `/twap` API Endpoint

### The problem

Our Risk Agent and Strategy Agent both need manipulation-resistant pricing to evaluate swap candidates. Spot quotes from `/quote` are trivially sandwichable, so we need TWAP prices. The `uniswap-ai` skill set has no oracle skill, and the Trading API has no time-weighted price endpoint. We fell back to CoinGecko 24h averages as a proxy, which is not ideal for a system that is supposed to be Uniswap-native.

The current official skill set — `swap-integration`, `swap-planner`, `liquidity-planner`, `v4-security-foundations`, `viem-integration`, `pay-with-any-token`, `configurator`, `deployer` — contains nothing for reading oracle data from pools.

### What the protocol already provides

Uniswap v3 has a fully built-in TWAP oracle. Every pool stores cumulative tick observations:

```solidity
struct Observation {
    uint32  blockTimestamp;
    int56   tickCumulative;  // cumulative sum of the active tick * seconds elapsed
    uint160 secondsPerLiquidityCumulativeX128;
    bool    initialized;
}
```

A TWAP price is derived by calling `pool.observe([0, windowSeconds])` and computing:

```
avgTick = (tickCumulative[now] - tickCumulative[T]) / windowSeconds
price   = 1.0001 ^ avgTick   (geometric mean, token1 per token0)
```

The [`OracleLibrary.sol`](https://github.com/Uniswap/uniswap-v3-periphery/blob/main/contracts/libraries/OracleLibrary.sol) helper in `v3-periphery` implements `getQuoteAtTick`, which converts the mean tick into a human-readable quoted amount. Observation history can be extended up to 65,535 slots (~9 days) by calling `pool.increaseObservationCardinalityNext`.

For **Uniswap v4**, there is currently no built-in oracle. A TWAP requires a custom `afterSwap` hook that manually accumulates `tickCumulative` on every swap — a non-trivial implementation with no reference example in the current `uniswap-ai` repo.

### Our ask

### Our ask

1. **Add a `twap-oracle` skill** to `uniswap-ai` (under `uniswap-trading` or a new `uniswap-oracle` plugin) that guides AI agents through reading v3 TWAP prices via `pool.observe` and `OracleLibrary.getQuoteAtTick`.
2. **Add a reference v4 TWAP hook** to the `uniswap-v4-hooks` plugin showing how to accumulate tick data in an `afterSwap` hook.
3. **Consider adding a `/twap` endpoint** to the Uniswap Trading API that accepts a pool address and a time window and returns the time-weighted price — this would remove any on-chain RPC dependency from the client side.

---

## Request 2 — Add a `pool-analytics` Skill and Pool Stats Endpoints

### The problem

Our Researcher Agent's entire job is to rank swap candidates by pool health. To do that it needs per-pool 24h volume, TVL, fee revenue, and transaction count. None of this data is available from Uniswap's own developer surface — the Trading API (`/quote`, `/swap`, `/check_approval`) is execution-only. We integrate both DeFiLlama and CoinGecko as workarounds, but both have latency, API key requirements, and coverage gaps for newer or low-liquidity pools.

The new `uniswap-driver` plugin (`liquidity-planner` + `swap-planner`) explicitly lists "API integration (Uniswap GraphQL, CoinGecko)" as a **future enhancement** in its own README — confirming this gap is known but unaddressed.

### What the protocol already provides

The Uniswap v3 Subgraph (hosted on The Graph) exposes exactly this data at per-pool granularity:

```graphql
# 24-hour pool analytics
{
  poolDayDatas(
    where: { pool: "<pool_address>" }
    orderBy: date
    orderDirection: desc
    first: 7
  ) {
    date
    volumeUSD
    tvlUSD
    feesUSD
    txCount
  }
}

# Intraday (hourly) granularity
{
  poolHourDatas(
    where: { pool: "<pool_address>" }
    orderBy: periodStartUnix
    orderDirection: desc
    first: 24
  ) {
    periodStartUnix
    volumeUSD
    tvlUSD
    txCount
  }
}
```

Subgraph endpoint: `https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3`

This data is Uniswap-native, pool-level precise, and requires no third-party API key.

### Our ask

1. **Add a `pool-analytics` skill** to `uniswap-ai` that guides AI agents through querying `poolDayDatas` and `poolHourDatas` from the v3 Subgraph, including how to authenticate with The Graph's hosted service.
2. **Consider adding `/pool/stats` or `/pool/volume` endpoints** to the Uniswap Trading API returning `volumeUSD`, `tvlUSD`, `feesUSD`, and `txCount` for a given pool address and time range. A single authenticated Uniswap-hosted endpoint here would eliminate the CoinGecko and DeFiLlama dependencies entirely.
3. **Add Subgraph documentation** on developers.uniswap.org alongside the existing swap and liquidity guides — even a simple guide pointing at `poolDayDatas` would be a significant improvement.

---

## Request 3 — Expose Per-Version Liquidity Depth for a Token Pair

### The problem

When a token pair exists across Uniswap v2, v3, and v4, there is no API surface that tells a developer how much liquidity is available in each version right now. The `protocols` field in `POST /quote` lets us restrict routing to a specific version (`V2`, `V3`, `V4`), but it does not expose the liquidity depth per version — it simply restricts where the router looks. To make an informed choice of where to swap or add liquidity, developers must stitch together third-party indexer data or issue raw RPC calls.

The recently shipped Liquidity Provisioning API (`/create`, `/increase`, `/decrease`, `/claim`, `/migrate`, `/claim_rewards`) and the `liquidity-planner` skill in the `uniswap-driver` plugin are both excellent additions that handle LP position execution and planning. However, `liquidity-planner` uses on-chain RPC + web search for data rather than a native pool-analytics surface — so the discovery problem (which version has the most liquidity for this pair?) remains unsolved.

### Our ask

1. **Add a version-liquidity endpoint** that returns, for a given token pair, the available pools by version (`v2`, `v3`, `v4`), fee tier, and current liquidity/TVL. Even a lightweight read-only endpoint that queries the Subgraph server-side and returns a normalised JSON response would be sufficient.
2. **Expose version selection in the swap flow** so integrators can lock a swap to a specific pool version after comparing liquidity depth, rather than relying on the auto-router to pick one opaquely.
3. **Document a canonical pool-selection decision flow**: discover pools by version → compare liquidity/volume/fees → user selects target → execute swap or add-liquidity via the existing API endpoints.

---

## Request 4 — Add a Unified Transaction Status Endpoint

### The problem

Our Executor Agent calls `POST /swap` or `POST /order` and gets back a transaction or order hash, but the pipeline has no way to confirm whether the transaction actually landed, was filled at the expected price, or reverted. Building a confirmation loop today requires branching on routing type (`CLASSIC` → poll `GET /swaps`, `DUTCH_V2`/`DUTCH_V3`/`PRIORITY` → poll `GET /orders`) and handling two different response shapes.

Both `GET /swaps` and `GET /orders` already exist and work well individually. The gap is purely the branching logic — an autonomous agent that does not inspect the `routing` field on the `/quote` response will silently call the wrong status endpoint and receive no error, just an empty result.

The `/quote` response includes a top-level `routing` field that determines which endpoint to use for both submission and status:

| `routing` value | Submit via | Status via |
| --------------- | ---------- | ---------- |
| `CLASSIC` | `POST /swap` | `GET /swaps?txHash=` |
| `DUTCH_V2`, `DUTCH_V3`, `PRIORITY` | `POST /order` | `GET /orders?orderHash=` |
| `WRAP`, `UNWRAP`, `BRIDGE` | `POST /swap` | `GET /swaps?txHash=` |

`GET /orders` also supports `?swapper=<address>&orderStatus=open` for querying open UniswapX orders on agent restart — this is good API design that we rely on.

### Our ask

1. **Add a unified `/tx/status` endpoint** that accepts either a `txHash` (classic AMM) or `orderHash` (UniswapX) and automatically routes to the correct backing check, returning a normalised response such as `{ status: "pending"|"confirmed"|"failed", executedAmountIn, executedAmountOut, gasUsed }`. This removes the need to branch on routing type and poll two endpoints with different shapes.

The routing dispatch documentation and the `GET /orders?swapper=&orderStatus=open` pattern are both already well-covered in the current docs — no further action needed there.

The four open items — TWAP oracle tooling, pool analytics, per-version liquidity discovery, and a unified status endpoint — are all derivable from data that Uniswap already produces natively. Surfacing them through `uniswap-ai` skills and/or the Trading API would keep the ecosystem self-contained and eliminate the need for third-party data providers in Uniswap-native applications.

We appreciate the quality of work the team has put into `uniswap-ai` and the developer documentation — the recent additions (Liquidity Provisioning API, `uniswap-driver`, `GET /swaps`, `GET /orders`, the AMM vs UniswapX routing guide) are all exactly the kind of first-class developer surface we would like to see expanded.
