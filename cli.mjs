#!/usr/bin/env node
// ComputeMarket operator agent.
//
//   computemarket start <operator-wallet-address>   run the agent (prints your box key)
//   computemarket check                             environment report, no network calls
//   computemarket service <operator-address>        print a systemd unit for auto-restart
//
// Holds no funds and sends no transactions: it signs messages with a throwaway box key
// generated on first run and stored in ~/.computemarket/box-key.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statfsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const REGISTRY_URL = (process.env.REGISTRY_URL ?? "https://computemarket-production.up.railway.app").replace(/\/$/, "");
const HOME = process.env.COMPUTEMARKET_HOME ?? path.join(homedir(), ".computemarket");
const KEY_FILE = path.join(HOME, "box-key.json");
const CONF_FILE = path.join(HOME, "config.json"); // remembers the operator wallet after `link`
const PID_FILE = path.join(HOME, "agent.pid"); // lets `computemarket off` find the running agent
const REGISTRY_ABI = [
  "function operators(address) view returns (uint256 staked, uint64 lockUntil, address boxKey, bool verified, bool firstJobDone, uint16 gpuWeight, uint64 lastAccrued, uint256 pendingUSDG, uint256 points)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// stderr ignored: missing tools are expected and handled by the catch sites
const sh = (cmd, args, timeout = 30_000) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();

// ---------- environment probe ----------
function probeEnvironment() {
  const probe = { cpuCores: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), node: process.version };
  try {
    const s = statfsSync(".");
    probe.diskFreeGB = Math.round((s.bsize * s.bavail) / 1e9);
    probe.diskTotalGB = Math.round((s.bsize * s.blocks) / 1e9);
  } catch { /* optional */ }
  try {
    probe.gpus = sh("nvidia-smi", ["--query-gpu=name,memory.total,driver_version,uuid", "--format=csv,noheader"])
      .split("\n").map((l) => { const [name, vram, driver, uuid] = l.split(", "); return { name, vram, driver, uuid }; });
  } catch { probe.gpus = []; }
  try { probe.cc = sh("nvidia-smi", ["conf-compute", "-f"]).slice(0, 120); } catch { probe.cc = "unavailable"; }
  try {
    const out = sh("python3", ["-c",
      "import torch;print(torch.__version__,torch.version.cuda,torch.cuda.is_available(),torch.cuda.device_count())"], 60_000).split(" ");
    probe.torch = out[0];
    probe.cuda = out[1];
    probe.cudaAvailable = out[2] === "True";
    probe.torchDevices = Number(out[3]);
  } catch { probe.torch = null; probe.cudaAvailable = false; }
  try { probe.interconnect = /NV\d/.test(sh("nvidia-smi", ["topo", "-m"])) ? "NVLink" : "PCIe"; } catch { probe.interconnect = null; }
  try { probe.mig = sh("nvidia-smi", ["--query-gpu=mig.mode.current", "--format=csv,noheader"]).split("\n")[0]; } catch { probe.mig = null; }
  return probe;
}

function boxKey() {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true });
  if (existsSync(KEY_FILE)) return new ethers.Wallet(JSON.parse(readFileSync(KEY_FILE)).privateKey);
  const w = ethers.Wallet.createRandom();
  writeFileSync(KEY_FILE, JSON.stringify({ privateKey: w.privateKey }), { mode: 0o600 });
  console.log(`[agent] new box key created at ${KEY_FILE}`);
  return new ethers.Wallet(w.privateKey);
}

const readConf = () => { try { return JSON.parse(readFileSync(CONF_FILE)); } catch { return {}; } };
const saveConf = (o) => {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true });
  writeFileSync(CONF_FILE, JSON.stringify({ ...readConf(), ...o }, null, 2));
};

const getConfig = async () => {
  const cfg = await fetch(`${REGISTRY_URL}/config`).then((r) => r.json()).catch(() => null);
  if (!cfg?.registry) { console.error(`error: cannot reach the ComputeMarket registry at ${REGISTRY_URL}`); process.exit(1); }
  return cfg;
};
const onchainOperator = (cfg) =>
  new ethers.Contract(cfg.registry, REGISTRY_ABI, new ethers.JsonRpcProvider(cfg.rpc));

// ---------- commands ----------
function cmdCheck() {
  const p = probeEnvironment();
  const gpu = p.gpus[0];
  console.log(`GPU         ${gpu ? `${gpu.name} ×${p.gpus.length} (${gpu.vram}, driver ${gpu.driver})` : "none detected — nvidia-smi failed"}`);
  console.log(`CUDA/torch  ${p.torch ? `torch ${p.torch}, CUDA ${p.cuda}, available=${p.cudaAvailable}` : "torch not installed (capability challenge will be skipped)"}`);
  console.log(`Interconnect ${p.interconnect ?? "unknown"}${p.mig && p.mig !== "N/A" ? ` · MIG ${p.mig}` : ""}`);
  console.log(`Host        ${p.cpuCores} vCPU · ${p.ramGB}GB RAM · ${p.diskFreeGB ?? "?"}GB free of ${p.diskTotalGB ?? "?"}GB`);
  console.log(`Confidential Computing  ${p.cc}`);
  const issues = [];
  if (!p.gpus.length) issues.push("no NVIDIA GPU visible");
  if (!p.cudaAvailable) issues.push("no CUDA-enabled torch (pip install torch)");
  if ((p.diskFreeGB ?? 0) < 60) issues.push(`only ${p.diskFreeGB}GB free disk — 60GB+ recommended to serve models`);
  console.log(issues.length ? `\nNot job-ready:\n  - ${issues.join("\n  - ")}` : "\nJob-ready ✓");
}

function cmdService(operator) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  console.log(`# save as /etc/systemd/system/computemarket.service, then:
#   sudo systemctl daemon-reload && sudo systemctl enable --now computemarket
[Unit]
Description=ComputeMarket operator agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=REGISTRY_URL=${REGISTRY_URL}
ExecStart=${process.execPath} ${path.join(dir, "cli.mjs")} start
Restart=always
RestartSec=10
User=${process.env.USER ?? "root"}

[Install]
WantedBy=multi-user.target`);
}

// One-time pairing: create this box's key and wait for the operator to bind it
// to their wallet on the website. Separate from `start` so the running agent
// never blocks on a human (which would break auto-restart on boot).
async function cmdLink(operator) {
  const cfg = await getConfig();
  const box = boxKey();
  const registry = onchainOperator(cfg);

  const existing = await registry.operators(operator).catch(() => null);
  if (existing?.boxKey === box.address) {
    saveConf({ operator });
    console.log(`Already linked ✓  this box (${box.address}) is bound to ${operator}.`);
    console.log("Run:  computemarket on");
    return;
  }

  // tell the registry this box is waiting, so the website can prefill the key
  await fetch(`${REGISTRY_URL}/link-request`, {
    method: "POST",
    body: JSON.stringify({
      operator, boxKey: box.address,
      sig: await box.signMessage(JSON.stringify({ operator, boxKey: box.address })),
    }),
  }).catch(() => null);

  console.log(`\n  BOX KEY:  ${box.address}`);
  if (cfg.site) console.log(`  LINK IT:  ${cfg.site}/?box=${box.address}`);
  console.log(`\nOpen the site — it should already show this box was detected. Click Link.`);
  console.log("(You must have staked first — the link binds this machine to your stake.)");
  console.log("\nWaiting for the link transaction...");

  for (;;) {
    const op = await registry.operators(operator).catch(() => null);
    if (op?.boxKey === box.address) break;
    await sleep(3000);
  }
  saveConf({ operator });
  console.log("\nLinked ✓  this machine is now bound to your wallet.");
  console.log("Next:  computemarket on");
}

async function cmdStart(operatorArg) {
  const operator = operatorArg ?? readConf().operator;
  if (!operator) {
    console.error("error: this box is not linked yet.\n  run:  computemarket link <your-wallet-address>");
    process.exit(1);
  }
  const probe = probeEnvironment();
  // COMPUTEMARKET_SIM_GPU is a dev override; real operators need real silicon
  const gpu = probe.gpus[0]?.name ?? process.env.COMPUTEMARKET_SIM_GPU;
  if (!gpu) {
    console.error("error: no NVIDIA GPU detected (nvidia-smi not available). A working GPU is required to operate.");
    process.exit(1);
  }
  console.log(`\nComputeMarket agent\n`);
  console.log(`  GPU        ${gpu}${(probe.gpus.length || 1) > 1 ? ` ×${probe.gpus.length}` : ""}`);

  // chain config comes from the registry, so contract redeploys need no reinstall
  const cfg = await getConfig();
  const box = boxKey();
  const registry = onchainOperator(cfg);

  // fail fast rather than blocking: a systemd service must never wait on a human
  const op = await registry.operators(operator).catch(() => null);
  if (op?.boxKey !== box.address) {
    console.error(`error: this box is not linked to ${operator} onchain.\n  run:  computemarket link ${operator}`);
    process.exit(1);
  }

  // pid + graceful shutdown: `computemarket off` (or Ctrl+C) tells the registry
  // immediately instead of leaving the watchdog to notice ~10s later
  writeFileSync(PID_FILE, String(process.pid));
  const goodbye = async () => {
    const payload = { operator, bye: true, ts: Date.now() };
    await fetch(`${REGISTRY_URL}/goodbye`, {
      method: "POST",
      body: JSON.stringify({ operator, payload, sig: await box.signMessage(JSON.stringify(payload)) }),
    }).catch(() => null);
  };
  let stopping = false;
  for (const s of ["SIGINT", "SIGTERM"]) {
    process.on(s, async () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log("\n[agent] going offline...");
      await goodbye();
      try { unlinkSync(PID_FILE); } catch { /* gone already */ }
      process.exit(0);
    });
  }

  // ponytail: real version calls nvtrust -> NVIDIA NRAS here for a signed JWT
  const token = { gpu, gpuCount: probe.gpus.length || 1, probe, boxKey: box.address, nonce: Date.now() % 1e9, nrasSig: "MOCK_NRAS_SIGNATURE" };
  const attest = await fetch(`${REGISTRY_URL}/attest`, {
    method: "POST", body: JSON.stringify({ operator, token, boxSig: await box.signMessage(JSON.stringify(token)) }),
  });
  const attestBody = await attest.json();
  if (!attest.ok) {
    console.error(`  Verified   ✗ ${attestBody.error ?? "attestation rejected"}`);
    process.exit(1);
  }
  console.log(`  Verified   ✓ weight ${attestBody.weight}`);
  if (attestBody.jobReady) console.log("  Job-ready  ✓");
  else if (attestBody.jobReadyReasons?.length)
    console.log(`  Job-ready  not yet — ${attestBody.jobReadyReasons.join(", ")}`);

  const runChallenge = async (quiet = false) => {
    const c = await fetch(`${REGISTRY_URL}/challenge?operator=${operator}`).then((r) => r.json()).catch(() => null);
    if (!c?.nonce) return;
    let out;
    const started = Date.now();
    if (!probe.cudaAvailable) {
      out = { ok: false, error: "torch not installed" }; // clean skip, no exec attempt
    } else {
      try {
        const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "challenge.py");
        out = JSON.parse(sh("python3", [script, c.nonce, String(c.vramGB)], 120_000).split("\n").pop());
      } catch { out = { ok: false, error: "challenge could not run on this machine" }; }
    }
    out.elapsedMs = Date.now() - started;
    const verdict = await fetch(`${REGISTRY_URL}/challenge`, {
      method: "POST", body: JSON.stringify({ operator, result: out, sig: await box.signMessage(JSON.stringify(out)) }),
    }).then((r) => r.json()).catch(() => null);
    if (quiet && verdict?.pass !== false) return; // periodic re-checks only speak up on bad news
    if (verdict?.skipped) console.log("  Challenge  skipped — needs Python + PyTorch (pip install torch)");
    else if (verdict?.pass) console.log(`  Challenge  ✓ ${out.tflopsMedian} TFLOP/s · ${out.memBwTBs} TB/s · ${out.vramAllocGB}GB proven`);
    else console.log(`  Challenge  ✗ ${verdict?.reason ?? "no verdict"} — weight demoted`);
  };
  await runChallenge();

  console.log(`\n  Online — earning at weight ${attestBody.weight}. Stop: Ctrl+C or \`computemarket off\`\n`);
  for (let seq = 0; ; seq++) {
    const payload = { operator, seq, ts: Date.now() };
    const r = await fetch(`${REGISTRY_URL}/heartbeat`, {
      method: "POST", body: JSON.stringify({ operator, payload, sig: await box.signMessage(JSON.stringify(payload)) }),
    }).catch(() => null);
    if (!r?.ok) console.log("  ! heartbeat failed — retrying");
    if (seq > 0 && seq % 75 === 0) await runChallenge(true);
    await sleep(4000);
  }
}

// Take this box offline: stop the running agent and tell the registry immediately.
// Stake is untouched (it's locked onchain) — only earning pauses until `on`.
async function cmdOff() {
  const conf = readConf();
  let killed = false;
  try {
    process.kill(Number(readFileSync(PID_FILE, "utf8")));
    killed = true;
  } catch { /* not running or stale pid */ }
  try { unlinkSync(PID_FILE); } catch { /* absent */ }
  // signed offline notice from here too — on Windows a killed process can't send its own
  if (existsSync(KEY_FILE) && conf.operator) {
    const box = new ethers.Wallet(JSON.parse(readFileSync(KEY_FILE)).privateKey);
    const payload = { operator: conf.operator, bye: true, ts: Date.now() };
    await fetch(`${REGISTRY_URL}/goodbye`, {
      method: "POST",
      body: JSON.stringify({ operator: conf.operator, payload, sig: await box.signMessage(JSON.stringify(payload)) }),
    }).catch(() => null);
  }
  console.log(killed ? "agent stopped — box offline." : "no running agent found — offline notice sent anyway.");
  console.log("Stake unchanged (still locked onchain). Rewards paused until:  computemarket on");
}

// ---------- entry ----------
const [cmd, arg] = process.argv.slice(2);
const needsAddress = (a) => {
  const addr = a ?? readConf().operator;
  if (!ethers.isAddress(addr ?? "")) { console.error("error: a valid operator wallet address is required"); process.exit(1); }
  return ethers.getAddress(addr);
};

if (cmd === "check") cmdCheck();
else if (cmd === "link") await cmdLink(needsAddress(arg));
else if (cmd === "service") cmdService(needsAddress(arg));
else if (cmd === "on" || cmd === "start") await cmdStart(arg ? needsAddress(arg) : readConf().operator);
else if (cmd === "off") await cmdOff();
else {
  console.log(`ComputeMarket operator agent

  computemarket check                   check this machine is ready (no network, no wallet)
  computemarket link <your-wallet>      pair this box with your wallet (once)
  computemarket on                      go online — attest, prove hardware, start earning
  computemarket off                     go offline — rewards pause, stake stays locked
  computemarket service                 print a systemd unit for auto-restart on boot

Set REGISTRY_URL if you are not using the default (${REGISTRY_URL}).`);
}
