# Kinzoku v2 (Kanaria Kinzoku)

Serverless claim flow for **Kanaria Founder/Super Founder** NFT owners to claim a physical metal/plexi plate.

- **Frontend**: single-page static site in `src/index.html` (no backend)
- **Contract**: `solidity/KinzokuV2.sol` (Base mainnet, chainId 8453)
- **Ops scripts**: `scripts/` (Bun) for deploys + decrypting claims + marking shipped

## Folder layout

- `src/`: frontend source (single HTML file)
- `dist/`: generated build output (`dist/index.html`) for ENS/IPFS deployment
- `solidity/`: Solidity contract sources (Foundry `src`)
- `script/`: Foundry scripts (deploy)
- `test/`: Foundry tests (fork tests)
- `scripts/`: Bun scripts (deploy frontend, deploy contract, decrypt claims, mark shipped)
- `deployments/`: deployment metadata written by scripts (e.g. `deployments/8453.json`)

## Setup

Prereqs:

- Foundry (`forge`, `cast`, `anvil`)
- Bun

Install Bun deps:

```bash
cd scripts
bun install
```

## Environment variables (`scripts/.env`)

Put your secrets in `scripts/.env` (it’s gitignored). Copy from env.example.

### Required for deploys

- `PRIVATE_KEY`: `0x...` hex private key.
  - Used for **contract deployment** (deployer becomes contract `owner`)
  - Used for **ENS contenthash update** (must be the ENS owner of `kinzoku.rmrk.eth`)
- `BASE_RPC_URL`: reliable Base RPC (used for **writes** and as the upstream for local forks)

### Optional but recommended

- `BASESCAN_API_KEY`: enables `forge script ... --verify` on Basescan during `contract:deploy`

### Frontend deployment (Filebase → IPFS)

Used by `bun run frontend:deploy`:

- `FILEBASE_BUCKET`
- `FILEBASE_BUCKET_KEY` (prefix/path inside the bucket)
- `FILEBASE_ROOT_KEY`
- `FILEBASE_ROOT_SECRET`
- `FILEBASE_ENDPOINT` (optional; defaults to `https://s3.filebase.com`)

### ENS update (mainnet)

- `ENS_NAME` (optional; default `kinzoku.rmrk.eth`)
- `ETH_RPC_URL` (optional; default `https://eth.llamarpc.com`)
- `SKIP_ENS=1` (optional; upload to IPFS but don’t touch ENS)
- `DRY_RUN=1` (optional; build only)

### Read-only RPCs (admin scripts)

- `PUBLIC_BASE_RPC_URL` (optional; defaults to `https://mainnet.base.org`)

### Overrides (mostly for local dev)

- `KINZOKU_ADDRESS`: if set, overrides reading `deployments/8453.json` for scripts/build
- `ENCRYPTION_PUBKEY`: if set, overrides reading `scripts/kinzoku-keys.json` for frontend build

## Contract

### Deploy to Base (and verify)

From `kinzoku-v2/scripts/`:

```bash
bun run contract:deploy
```

This runs a CREATE2 deploy script (`script/Deploy.s.sol`) and writes deployment metadata to:

- `deployments/8453.json`

Verification:

- If `BASESCAN_API_KEY` is present, the deploy includes `--verify` automatically.

### Tests (local Base fork via Anvil)

This starts an Anvil fork of Base and runs fork-tests using the address derived from `PRIVATE_KEY` (so you can exercise `onlyTokenOwner` against real Kanaria ownership on the fork):

```bash
cd scripts
bun run test
```

Notes:

- If you run `forge test` directly, these fork tests are skipped unless you set `RUN_FORK_TESTS=1` + `FORK_URL=...`.

## Encryption keys

Claims store an **encrypted payload** on-chain (shipping address + contact + type).

Generate a keypair once:

```bash
cd scripts
bun run keygen
```

Outputs:

- `scripts/kinzoku-keys.json` (gitignored)
  - `publicKey`: injected into the frontend build
  - `secretKey`: used by `bun run fetch` to decrypt claims

Public key is auto hardcoded into frontend on build if it exists in the folder.

## Frontend

The frontend loads **only local assets** from `src/assets/` (no CDN dependencies).

### Local Anvil fork (for UI testing)

From `scripts/`:

```bash
bun run anvil
```

This starts an Anvil **fork of Base** at `http://127.0.0.1:8545` (chainId `31337`) **and deploys `KinzokuV2` to the fork**.

On `localhost`, the frontend uses a hardcoded local contract address (so you don’t need to rebuild just to test):

- `KinzokuV2` (local): `0xC5273AbFb36550090095B1EDec019216AD21BE6c`

If you want the local fork to reflect **already-claimed birds from the old v1 contract**, run:

```bash
cd scripts
bun run migrate:v1
```

To reflect the same “already shipped in v1” status on **Base mainnet**, run:

```bash
cd scripts
bun run migrate:v1:base
```

### Local build

```bash
cd scripts
bun run frontend:build
```

This writes `dist/index.html` + `dist/assets/` and injects:

- `KINZOKU_ADDRESS` (from `deployments/8453.json`, or env override)
- `ENCRYPTION_PUBKEY` (from `kinzoku-keys.json`, or env override)

### Deploy to `kinzoku.rmrk.eth`

```bash
cd scripts
bun run frontend:deploy
```

Flow:

1. Builds `dist/index.html` + `dist/assets/`
2. Uploads `dist/assets/` to Filebase (IPFS) and rewrites `dist/index.html` to point at the pinned asset CIDs (via `FILEBASE_IPFS_GATEWAY`)
3. Uploads the rewritten `dist/index.html` to Filebase (IPFS)
4. Sets ENS contenthash on mainnet for `kinzoku.rmrk.eth` (pointing at the `index.html` CID)

### Local chain switching behavior

- If the site is served from **localhost** (`localhost` / `127.0.0.1`), it reads from **Anvil** (`http://127.0.0.1:8545`, chainId `31337`)
- Otherwise it reads from public Base RPCs and prompts the wallet to switch to **Base mainnet** (`8453`)

Wallet UX:

- If you have multiple injected wallets installed (e.g. MetaMask + Rabby), the UI uses **EIP-6963** discovery and shows a small **wallet picker** so you can choose which wallet to connect.

## Ops scripts (decrypt + ship)

### Fetch + decrypt pending claims

```bash
cd scripts
bun run fetch
```

Reads from `PUBLIC_BASE_RPC_URL` (default `https://mainnet.base.org`) and decrypts with `kinzoku-keys.json`.

### Fetch + decrypt pending claims (local Anvil)

```bash
cd scripts
bun run fetch:local
```

Reads from local Anvil (`LOCAL_RPC_URL`, default `http://127.0.0.1:8545`) and decrypts with `kinzoku-keys.json`.

### Mark claims as shipped (on-chain)

```bash
cd scripts
bun run ship 1 5 23
```

Uses:

- public RPC for reads (`PUBLIC_BASE_RPC_URL`)
- paid RPC for writes (`BASE_RPC_URL`)
