# Developer Feedback — Uniswap AI & Developer Docs

**To:** Uniswap Labs Developer Experience Team  
**Repo:** https://github.com/Uniswap/uniswap-ai  
**Docs:** https://developers.uniswap.org/docs  
**Date:** 26 April 2026

---

## Overview

We are building a multi-agent DeFi system on top of Uniswap v3. While the `uniswap-ai` skill set and the Uniswap Developer Documentation are both excellent starting points, we encountered two meaningful gaps during integration that required us to patch in third-party data providers (DeFiLlama, CoinGecko) as workarounds. We believe both gaps are well within Uniswap's ability to address natively, and we would strongly encourage the team to do so.

---

## Request 1 — Expose a TWAP Endpoint or Add a `twap-oracle` Skill

### The gap

The `uniswap-ai` repo contains skills for swap integration, hook development, and liquidity management, but provides no guidance on reading **Time-Weighted Average Prices (TWAP)** from Uniswap pools. The Uniswap Trading API likewise only returns spot quotes — there is no time-weighted price endpoint.

This leaves developers without a sanctioned path to manipulation-resistant pricing, which is a fundamental requirement for any serious on-chain application.

### What already exists at the protocol level

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

1. **Add a `twap-oracle` skill** to `uniswap-ai` (under `uniswap-trading` or a new `uniswap-oracle` plugin) that guides AI agents through reading v3 TWAP prices via `pool.observe` and `OracleLibrary.getQuoteAtTick`.
2. **Add a reference v4 TWAP hook** to the `uniswap-v4-hooks` plugin showing how to accumulate tick data in an `afterSwap` hook.
3. **Consider adding a `/twap` endpoint** to the Uniswap Trading API that accepts a pool address and a time window and returns the time-weighted price — this would remove the need for any on-chain RPC call from the client side.

---

## Request 2 — Expose Pool Volume and TVL Endpoints or Add a `pool-analytics` Skill

### The gap

The Uniswap Trading API (`/quote`, `/swap`, `/check_approval`) is entirely focused on trade execution. There is no endpoint for **pool trading volume**, **TVL**, **fee revenue**, or **transaction count**. The `uniswap-ai` skill set similarly has no skill that helps developers query these metrics.

Because this data is absent from Uniswap's own developer surface, teams are forced to integrate DeFiLlama and CoinGecko just to answer basic questions like *"how much volume did this pool do in the last 24 hours?"*. Both of those providers have their own latency, API key requirements, and coverage gaps — particularly for newer or lower-liquidity pools that may not yet be indexed.

### What already exists at the protocol level

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
    volumeUSD   # total USD volume traded that day
    tvlUSD      # total value locked at close of day
    feesUSD     # protocol fees earned
    txCount     # number of swap transactions
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

This data is Uniswap-native, pool-level precise, and does not require a third-party API key.

### Our ask

1. **Add a `pool-analytics` skill** to `uniswap-ai` (under a new `uniswap-analytics` plugin or as an extension of `uniswap-trading`) that guides AI agents through querying `poolDayDatas` and `poolHourDatas` from the v3 Subgraph.
2. **Consider adding official `/pool/stats` or `/pool/volume` endpoints** to the Uniswap Trading API that return `volumeUSD`, `tvlUSD`, `feesUSD`, and `txCount` for a given pool address and time range. This would give developers a single, authenticated, Uniswap-hosted surface for all pool data — eliminating the need to query The Graph or DeFiLlama separately.
3. **Add documentation** on developers.uniswap.org covering how to query pool analytics from the Subgraph, alongside the existing swap and liquidity guides.

---

## Summary

| Feature | Protocol support today | `uniswap-ai` skill | Trading API endpoint |
|---|---|---|---|
| TWAP price (v3) | ✅ `pool.observe()` + `OracleLibrary` | ❌ Missing | ❌ Missing |
| TWAP hook (v4) | ⚠️ Requires custom `afterSwap` hook | ❌ No reference example | ❌ N/A |
| Pool volume (24h) | ✅ v3 Subgraph `poolDayData.volumeUSD` | ❌ Missing | ❌ Missing |
| Pool TVL | ✅ v3 Subgraph `poolDayData.tvlUSD` | ❌ Missing | ❌ Missing |
| Pool fee revenue | ✅ v3 Subgraph `poolDayData.feesUSD` | ❌ Missing | ❌ Missing |

Both features are fully supported at the protocol level. Surfacing them through `uniswap-ai` skills and/or the Trading API would significantly reduce the integration burden for developers building on Uniswap and would keep the ecosystem self-contained — removing the dependency on DeFiLlama and CoinGecko for data that Uniswap already produces natively.

We appreciate the work the team has put into `uniswap-ai` and the developer documentation, and we hope this feedback is useful.
