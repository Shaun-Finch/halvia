// Runs the WebLLM engine off the main thread so the chat stays responsive while the model works.
import { WebWorkerMLCEngineHandler } from './vendor/web-llm.js';
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = msg => handler.onmessage(msg);
