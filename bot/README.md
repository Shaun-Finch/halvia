# Halvia bot

An AI assistant for clinicians that runs on the device and works with no internet. Live at **https://halvia.cloud/bot/**.

## How it works

- **On-device AI.** [WebLLM](https://github.com/mlc-ai/web-llm) runs Llama 3.2 (1B or 3B) or Phi-3.5 mini on the device's GPU through WebGPU, inside a web worker (`llm-worker.js`). The model downloads once from Hugging Face and is cached by the browser, so it keeps working offline.
- **Answers from a library.** Every question is searched against a local library (BM25 over passages, in `bot.js`). The best passages go to the model with the question, and the answer cites them. Without the model (not downloaded, or no WebGPU), the bot answers by quoting the most relevant sentences.
- **Teaching it.** Signed-in users add PDFs (pdf.js), Word `.docx` files, text, Markdown, HTML, CSV or pasted text. Documents are split into passages and indexed. This is retrieval, not fine-tuning: the model reads your documents at answer time and shows which passages it used.
- **Profiles.** Local profiles on the device. Documents and chats are stored in IndexedDB, encrypted with AES-GCM using a key derived from the passcode (PBKDF2, 310,000 rounds). Profiles lock after 15 minutes without use.
- **Offline app.** `sw.js` caches the app shell and starter library on first visit, and the AI engine and PDF reader when first used. `manifest.webmanifest` makes it installable.

## Files

- `index.html`, `bot.css`, `bot.js` — the app
- `llm-worker.js` — runs the model off the main thread
- `sw.js`, `manifest.webmanifest`, `icons/` — offline cache and install
- `library/` — the starter library: summaries of public UK guidance, each naming its source
- `vendor/` — WebLLM 0.2.85 (Apache-2.0) and pdf.js 4.10.38 (Apache-2.0), self-hosted so they work offline

## Next

- Accounts that sync across devices, and shared team libraries (needs a backend with NHS-grade hosting and a DPIA)
- Android and iOS: wrap this web app with Capacitor first, then move the model to native on-device runtimes (MLC LLM, llama.cpp, Core ML) for speed
- Embedding search alongside keyword search, and OCR for scanned PDFs

Prototype. Not a medical device and not for clinical decisions.
