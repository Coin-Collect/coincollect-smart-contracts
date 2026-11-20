# CoinCollect Universal Rewards V3

Universal Rewards V3 creates numbered NFT reward pools in a shared settlement contract on Polygon. V2 pools continue to use their existing contracts and custody rules.

## Architecture

| Contract | Responsibilities |
| --- | --- |
| `UniversalRewards` | Creates pools, accounts for funding and independent ERC-20 reward reserves, and handles NFT enrollment, accrual, claims, and exits. |
| `RewardSwapAdapter` | Executes exact-input replenishment swaps on configured direct pairs. It verifies router and pair code, reserve bounds, cumulative-price observations, minimum output, and deadlines. |
| `FinalizedOwnershipVerifier` | Accepts a configured quorum of distinct EIP-712 witnesses for finalized remote ERC-721 ownership. The verifier and the ledger integration are restricted to local chain 31337. |

The ledger checks Polygon ERC-721 ownership on chain and leaves the NFT in its owner's wallet. Accrued rewards follow the NFT's current owner. A checkpoint settles the preceding interval for the last verified roster before reconciling owners for the next interval. A transfer can therefore take until the next checkpoint to affect future accrual. Each reward token has a separate cap and funded reserve.

A pool can take a single budget asset and allocate it across reward tokens. Native POL can enter through the configured wrapped asset. A same-asset allocation moves funds into the reward reserve directly. A cross-asset allocation uses an enabled adapter route. Each token can be replenished once per funding epoch when its conditions are met. The application or an operator can submit eligible replenishment transactions.

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

The fork reads from an HTTPS Polygon archive RPC and executes transactions on a disposable loopback Anvil with chain ID 31337. Market inspection only reads Polygon. If the default endpoint cannot serve the pinned block, set `COINCOLLECT_V3_POLYGON_RPC` to an archive-capable endpoint. The other optional variables are documented in [`.env.example`](.env.example). Export values in your shell or load a local file explicitly, for example `node --env-file=.env --test scripts/polygon-fork.cjs`. The workflow's manually triggered fork test can read the archive URL from a GitHub Actions secret.

## Frontend ABI

Export the three TypeScript ABIs and compare them against the frontend's `pool-management` checkout. From this directory, with both repositories cloned into the same parent directory, run:

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
