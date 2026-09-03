"""GPU capability challenge — run on the box, results returned to the registry.

Verifies physics, not spec sheets: a card that lacks the VRAM or the memory
bandwidth it claims cannot produce these numbers, whatever nvidia-smi says.

Methodology (from the incognito-challenge harness): warm up, then sample many
times, and report the distribution — a single timing is noise, a distribution
is a signature.

Usage: python challenge.py <nonce-hex> <vram-gb>
Outputs one JSON line. Requires torch + CUDA.
"""
import json, sys, time

def main():
    nonce_hex, vram_gb = sys.argv[1], float(sys.argv[2])
    try:
        import torch
    except ImportError:
        print(json.dumps({"ok": False, "error": "torch not installed"})); return
    if not torch.cuda.is_available():
        print(json.dumps({"ok": False, "error": "no CUDA device"})); return

    dev = torch.device("cuda:0")
    seed = int(nonce_hex[:15], 16)  # nonce drives the data: precomputation is useless
    torch.manual_seed(seed)

    # torch/cuda versions recorded so a spot-check verifier can reproduce the run
    result = {"ok": True, "nonce": nonce_hex, "device": torch.cuda.get_device_name(0),
              "torch": torch.__version__, "cudaRt": torch.version.cuda}

    # 1. VRAM claim: allocate what an honest card of this class must hold.
    # A smaller card OOMs here — it cannot fake capacity it does not have.
    try:
        n = int(vram_gb * 1e9 / 4)  # float32
        big = torch.empty(n, dtype=torch.float32, device=dev).uniform_(-1, 1)
        torch.cuda.synchronize()
        result["vramAllocGB"] = round(n * 4 / 1e9, 1)
        # checksum binds the answer to the nonce-seeded data
        result["checksum"] = float(big[::9973].double().sum().item())
        del big
        torch.cuda.empty_cache()
    except RuntimeError as e:
        print(json.dumps({"ok": False, "error": f"vram: {str(e)[:120]}"})); return

    # 2. Compute throughput: sustained matmul TFLOP/s. Distribution, not a single sample.
    size = 8192
    a = torch.randn(size, size, device=dev, dtype=torch.float16)
    b = torch.randn(size, size, device=dev, dtype=torch.float16)
    for _ in range(5):  # warmup: let clocks and autotuning settle
        a @ b
    torch.cuda.synchronize()
    # second nonce-bound checksum: a sparse sample of the full product binds the matmul
    # work itself, so a verifier re-running with the same nonce can compare both sums
    result["matmulChecksum"] = float((a @ b)[::997, ::997].double().sum().item())

    samples = []
    for _ in range(20):
        t0 = time.perf_counter()
        a @ b
        torch.cuda.synchronize()
        samples.append(time.perf_counter() - t0)
    flop = 2 * size ** 3
    tflops = sorted(flop / s / 1e12 for s in samples)
    result["tflopsMedian"] = round(tflops[len(tflops) // 2], 1)
    result["tflopsP10"] = round(tflops[2], 1)
    result["tflopsP90"] = round(tflops[-3], 1)

    # 3. Memory bandwidth: HBM is the hardest thing to fake — GDDR cards can't reach it.
    buf = torch.empty(int(2e9 // 4), dtype=torch.float32, device=dev)
    for _ in range(3):
        buf.mul_(1.0001)
    torch.cuda.synchronize()
    bw = []
    for _ in range(10):
        t0 = time.perf_counter()
        buf.mul_(1.0001)
        torch.cuda.synchronize()
        bw.append(buf.numel() * 4 * 2 / (time.perf_counter() - t0) / 1e12)  # read+write TB/s
    bw.sort()
    result["memBwTBs"] = round(bw[len(bw) // 2], 2)

    print(json.dumps(result))

if __name__ == "__main__":
    main()
