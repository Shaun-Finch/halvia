"""Run Halvia bot's exact prompts through the same models (GGUF builds, CPU) to check answer quality."""
import json, sys, time
from huggingface_hub import hf_hub_download
from llama_cpp import Llama

MODELS = [
    ("Llama 3.2 1B (Fast)", "bartowski/Llama-3.2-1B-Instruct-GGUF", "Llama-3.2-1B-Instruct-Q4_K_M.gguf"),
    ("Llama 3.2 3B (Better)", "bartowski/Llama-3.2-3B-Instruct-GGUF", "Llama-3.2-3B-Instruct-Q4_K_M.gguf"),
]
prompts = json.load(open("tools/eval/prompts.json"))
out = ["# Halvia bot answer quality check\n", "Same prompts and sources the app sends; temperature 0.2. GGUF Q4 builds on CPU, so wording can differ slightly from the in-browser model.\n"]
for name, repo, fn in MODELS:
    path = hf_hub_download(repo, fn)
    llm = Llama(model_path=path, n_ctx=4096, n_threads=4, verbose=False)
    out.append(f"\n## {name}\n")
    for p in prompts:
        t0 = time.time()
        r = llm.create_chat_completion(messages=p["messages"], temperature=0.1, max_tokens=450)
        txt = r["choices"][0]["message"]["content"].strip()
        out.append(f"\n### Q: {p['q']}\n_{time.time() - t0:.0f}s_\n\n{txt}\n")
        print(name, p["q"], "->", txt[:200].replace("\n", " "), flush=True)
        open("tools/eval/answers.md", "w").write("\n".join(out))
