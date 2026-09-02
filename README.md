# ComputeMarket operator agent

Prove your GPU is real, earn rewards. The agent reads your hardware, answers capability challenges, and heartbeats to show you're online. **It holds no funds and sends no blockchain transactions** — it signs messages with a throwaway key generated on your machine at `~/.computemarket/box-key.json`.

## Install

Requires **Node.js 20+** and, for the capability challenge, **Python 3 with PyTorch** (already present on most GPU images).

```bash
npm install -g github:computemarketapp/agent
```

<details>
<summary>If Node.js isn't installed</summary>

```bash
# Ubuntu / Debian / RunPod PyTorch images
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

# Docker image without sudo
apt update && apt install -y nodejs npm
```
</details>

## Use

```bash
computemarket check                # 1. is this machine ready? (no network, no wallet)
computemarket link 0xYourWallet    # 2. pair this box with your wallet (once)
computemarket on                   # 3. go online and start earning
computemarket off                  #    go offline — rewards pause, stake stays locked
```

**Step 2** prints your box key and a link. Open it, connect the wallet you staked with, click **Link** — the agent detects the transaction and confirms:

```
  BOX KEY:  0xE294d766F927AD8Abe40137d00455CD49131eCAF
  LINK IT:  https://computemarket.app/?box=0xE294d766F927AD8Abe40137d00455CD49131eCAF
```

Pairing happens once. After that `start` needs no arguments — the wallet is remembered in `~/.computemarket/config.json`.

## Keep it running

```bash
computemarket service | sudo tee /etc/systemd/system/computemarket.service
sudo systemctl daemon-reload && sudo systemctl enable --now computemarket
```

Your machine now rejoins automatically after a reboot. Stopping the service takes you offline; already-earned rewards are unaffected.

## What gets sent

Hardware facts only: GPU model/count/VRAM/driver/UUID, CPU cores, RAM, free disk, CUDA + torch versions, interconnect, MIG mode, and Confidential-Computing status — plus signed challenge results and heartbeats. No file contents, no workloads, no keys.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `REGISTRY_URL` | `https://computemarket-production.up.railway.app` | Registry endpoint (chain config is fetched from it) |
| `COMPUTEMARKET_HOME` | `~/.computemarket` | Where the box key is stored |
