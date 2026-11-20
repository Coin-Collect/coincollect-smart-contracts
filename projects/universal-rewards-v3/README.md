# CoinCollect Universal Rewards V3

Universal Rewards V3 creates numbered NFT reward pools in a shared settlement contract on Polygon. V2 pools continue to use their existing contracts and custody rules.

## V3.5 Polygon release candidate

See the [audit package and compatibility matrix](V3.5.md), [release manifest](release-manifest.json) and [deployment and incident runbook](V3.5-operations.md).

## V3.4 compatibility and hardening

The [V3.4 operating report](V3.4.md) covers the supported collection model, transfer failure behavior, source reconciliation, measured gas and isolated deployment gates.

## V3.3 mixed-chain and mixed-standard pools

The new version supports approved Polygon ERC-1155 transfer hooks alongside native ERC-721. Base and Arbitrum ERC-721 and ERC-1155 are available in isolated journal tests. See the [V3.3 architecture, gas and deployment gates](V3.3.md).

## V3.2 unified admin and shared treasury

V3.2 uses the CoinCollect admin wallet as both the pool administrator and immutable treasury owner. Use that address to govern the approved planner and route adapters as well. The admin deposits ERC-20s or native POL as WPOL and can withdraw the vault's recorded available balance. The automation executor has its own gas-only wallet without administrative authority. Creating a pool can reserve its lifetime budget atomically. Each allocation moves exact ERC-20 units into that pool's ledger balance and reduces the vault's available balance. The vault records outstanding allocations, purchase spend, returns and withdrawals independently. Purchased inventories and reserved NFT credits remain in the ledger per pool and token.

Allocations remain locked until the pool ends. The ledger can return unspent funding then, and expired claims at the existing 30-day deadline. The vault can pause new deposits, withdrawals, allocations and purchases while claims and returns remain available. Only use explicit deposits. An unsolicited transfer to the vault does not create a spendable accounting balance. Directly funded V3 pools retain their original payout and recovery paths.

The route planner checks up to four approved candidates. A candidate can be one existing V2-style adapter or two adapters joined by an approved token. Each hop has pinned router and pair identity, reserve floors, a capped input share, fresh TWAP, a bounded spot deviation and a minimum output. Exact balance checks cover the funding, intermediate and reward assets. A failed candidate rolls back before a different candidate can execute. The highest verified output is tried first within the caller's minimum and deadline. Compatible tokens must have standard balances and transfers.

For a 10 USDT, 365-day pool, 50%, 30% and 20% splits cap lifetime input at 5, 3 and 2 USDT. A consolidated purchase can acquire those tokens early. Emission is still spread over 365 days. Adaptive purchases use the configured reserve horizon and one purchase per token per epoch. POL gas is paid separately and never charged against the pool budget.

### Verified Polygon routes

The V3.1 fork test pins block `97638790`, router and pair code hashes. It executes USDT → WPOL via QuickSwap V2, USDT → WPOL → COLLECT through QuickSwap V2 and CoinCollect, and USDT → WPOL → SHIB through QuickSwap V2. A 5 USDT consolidated COLLECT purchase failed the tested depth limits. Direct USDT → SHIB held about 1.996 USDT on the input side, far below the depth required for a 2 USDT allocation. That path is rejected in the test and the WPOL path succeeds. These observations apply to the pinned block. [QuickSwap Polygon V2 deployments](https://docs.quickswap.exchange/overview/contracts-and-addresses)

The first 30-day tranches used about 384–393k gas for WPOL, 623k for COLLECT and 626–634k for SHIB across fork runs. At 30 gwei this is about 0.0115–0.0118, 0.0187 and 0.0188–0.0190 POL respectively. These figures exclude separately submitted TWAP observations. Runtime estimates and fees depend on state, path, fallback and Polygon gas prices.

### Versioned deployment and operations

For a disposable isolated environment, run `scripts/deploy-browser-fixture.cjs`. Its V3.2 manifest includes the ledger runtime hash, attached vault and scale-test seeder. The Polygon fork tests build a second fixture using real router and token state. Both setups verify a loopback Anvil before writes.

An authorized rollout would need new contract addresses. Use the reviewed CoinCollect admin address for the treasury, ledger administration and governance of the adapters and planner. Use a dedicated gas-only executor. Deploy the reviewed adapters and planner, verify route and token configuration, deploy the new ledger, deploy its vault and have the admin attach it once. Verify the chain and runtime hash before changing the frontend configuration. Legacy pools stay on their original ledger. Production configuration and third-party security review are separate release requirements.

Pause the vault to stop new treasury exposure, and pause a planner or leaf adapter to block suspect swaps. Users can continue claiming under the existing deadline. For settlement, call `recoverBudget` after a pool ends and `recoverExpiredRewards` per token after the claim deadline. A blocked token can be retried independently. Trusted operators still choose NFT collections and pool budgets. TWAPs can be distorted in weak markets, and slippage guards reduce rather than eliminate MEV exposure.

## Architecture

| Contract | Responsibilities |
| --- | --- |
| `UniversalRewards` | Creates pools, accounts for funding and independent ERC-20 reward reserves, and handles NFT enrollment, accrual, claims, and exits. |
| `RewardSwapAdapter` | Executes exact-input replenishment swaps on configured direct pairs. It verifies router and pair code, reserve bounds, cumulative-price observations, minimum output, and deadlines. |
| `FinalizedOwnershipVerifier` | Accepts a configured quorum of distinct EIP-712 witnesses for finalized remote ERC-721 ownership. The verifier and the ledger integration are restricted to local chain 31337. |

The ledger checks Polygon ERC-721 ownership on chain and leaves the NFT in its owner's wallet. Accrued rewards follow the NFT's current owner. Each reward token has its own cumulative reward-per-weight index, cap and funded reserve. At a checkpoint the ledger applies the existing distinct-wallet threshold and available-inventory limit, divides the interval emission by total NFT power, and reserves the index increment multiplied by total power. Each NFT realizes its weighted index change when touched. Division truncates fewer than `totalWeight` scaled subunits per token per checkpoint. Payouts round down to whole ERC-20 base units. Polygon checkpoints never read the list of active NFTs.

Eligibility and payouts check the NFT's current owner in the transaction. Transfers update observed wallet counts once the affected position is reconciled. Anyone can submit up to 32 position keys per reconciliation. Keys are processed in order, releasing their old seats and checking the receiving wallet's limits before admitting them. A position dropped by a cap can re-enroll if eligible, with its vested rewards attached to its NFT identity. The ledger exposes paginated pool and wallet history and constant-time counts of recorded seats. The 65,535-position encoding limit is distinct from the largest benchmarked pool.

Isolated remote seats retain a separate 32-seat bound. A checkpoint advances to each due proof expiry before dropping the seat and applying the updated weight and wallet threshold for the subsequent interval. Preview reads can conservatively stop at the earliest overdue proof until a checkpoint catches up. The production Polygon build cannot enable the remote verifier.

A pool can take a single budget asset and allocate it across reward tokens. Native POL can enter through the configured wrapped asset. A same-asset allocation moves funds into the reward reserve directly. A cross-asset allocation uses an enabled adapter route. Each token can be replenished once per funding epoch when its conditions are met. The application or an operator can submit eligible replenishment transactions.

Accrual ends at the pool's configured end time. The current NFT owner can claim until the settlement chain reaches `pool.end + 30 days`. At that exact timestamp, claims and reward-paying exits expire. Anyone can then call `recoverExpiredRewards` for each remaining reward token. Recovery pays the immutable treasury from the selected pool's inventory. It can be retried per token and returns zero after successful settlement. Before the deadline, `recoverSurplus` can recover only uncommitted rewards after the pool ends. Unspent funding retains its independent `recoverBudget` path.

## Install, compile and test

Use Node.js 22, as configured in the repository's GitHub Actions workflow. From `projects/universal-rewards-v3`, run these commands. The workspace flag selects this project's own lockfile inside the repository.

```sh
npm ci --workspaces=false --ignore-scripts
npm run --workspaces=false compile
npm test --workspaces=false
```

The lockfile pins Solidity 0.8.30, OpenZeppelin Contracts 5.4.0, ethers 5.8.0, and Anvil 1.7.1. The compiler uses the optimizer, IR, and the Paris EVM target. The isolated test suite starts temporary loopback Anvil instances and covers settlement, funding, swap restrictions, and local ownership verification. The GitHub workflow has read-only repository permissions and runs the compiler and isolated tests automatically for V3 changes on `pool-management`.

To verify the reviewed WPOL-to-COLLECT route using Polygon state at block `97638790`, run:

```sh
npm run --workspaces=false test:polygon-fork
npm run --workspaces=false inspect:polygon-market -- 97638790
```

The fork reads from an HTTPS Polygon archive RPC and executes transactions on a disposable loopback Anvil with chain ID 31337. Market inspection only reads Polygon. If the default endpoint cannot serve the pinned block, set `COINCOLLECT_V3_POLYGON_RPC` to an archive-capable endpoint. The other optional variables are documented in [`.env.example`](.env.example). Export values in your shell or load a local file explicitly, for example `node --env-file=.env --test scripts/polygon-fork.cjs`. The required fork workflow can read the archive URL from a GitHub Actions secret.

### V3.2 gas measurements

Run `node --test test/scalability.test.cjs` to reproduce the measurements on isolated Anvil. The benchmark uses one pool, four reward tokens and two NFT weights, with eight positions per wallet. Each row measures a single additional position, including claiming all four rewards and settling one expired reward token. The different initialization cost in the first row comes from creating index and payout storage.

| Active NFTs | Join | Checkpoint, four rewards | Reconcile one NFT | Claim | Exit | Settle one token |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 582,427 | 110,264 | 367,557 | 365,481 | 302,986 | 94,862 |
| 128 | 428,527 | 110,264 | 350,457 | 297,081 | 302,986 | 94,862 |
| 512 | 427,863 | 109,600 | 349,793 | 296,417 | 302,322 | 94,862 |
| 1,024 | 427,863 | 109,600 | 349,793 | 296,417 | 302,322 | 94,862 |

## Frontend ABI

Export the TypeScript ABIs and compare them against the frontend's `pool-management` checkout. From this directory, with both repositories cloned into the same parent directory, run:

```sh
abi_dir=$(mktemp -d)
node scripts/export-abi.cjs "$abi_dir/abi.ts"
cmp "$abi_dir/abi.ts" ../../../coincollect-frontend/src/features/universalRewards/abi.ts
```

The exporter omits constructors because the frontend uses the ABIs to interact with existing instances.

## Local deployment tools and security status

For browser testing, start a fresh Anvil on `127.0.0.1:18545` with chain ID 31337. Then run:

```sh
node scripts/deploy-browser-fixture.cjs
```

The fixture requires a loopback HTTP RPC, checks chain ID and Anvil identity, and uses local unlocked accounts. It deploys test assets and a funded sample pool and prints fixture addresses for frontend testing. The finalized observation helper produces unsigned evidence from agreeing HTTPS RPCs. Witness keys stay outside this project.

This publication is for source review and local verification. Before using real assets, independently review contract invariants, supported tokens and collections, operator and treasury assignments, each enabled swap route, and the execution and recovery procedures. The cross-chain verifier remains an isolated prototype with an explicit quorum and RPC trust model. Keep private keys, seed phrases, signer configuration, API tokens, and authenticated RPC URLs outside Git. The template contains no credentials.

The publication dependency audit reported 17 affected npm packages, including high-severity findings for the transitive `tmp` and `ws` packages. The existing lockfile is pinned for source and ABI reproduction. Run `npm audit --workspaces=false` for the current advisory list and address these findings before relying on the tooling in a production environment.
