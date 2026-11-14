// Loads the Firefox background scripts into a VM with mocked WebExtension APIs.
// This exercises the Firefox-only path: event page + inline engine + promise APIs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(root, 'dist', 'firefox');
const scripts = ['api.js', 'stitcher.js', 'engine.js', 'bridge-firefox.js', 'background-core.js'];

const goodPano = 'jGaYvr31o-KsarHZtXbc5w';
const badPano = 'CIHM0ogKEICAgID82oiv6gE';

const storage = new Map();
const relayed = [];
const downloads = [];
let runtimeListener = null;

const api = {
    runtime: {
        onMessage: {
            addListener(listener) {
                runtimeListener = listener;
            },
        },
        getURL: (file) => `moz-extension://peerripper/${file}`,
    },
    tabs: {
        async sendMessage(tabId, message) {
            relayed.push({ tabId, ...message });
        },
    },
    downloads: {
        async download(options) {
            downloads.push(options);
            return downloads.length;
        },
        onChanged: {
            addListener() {},
        },
    },
    storage: {
        session: {
            async get(key) {
                return storage.has(key) ? { [key]: storage.get(key) } : {};
            },
            async set(values) {
                for (const [key, value] of Object.entries(values)) storage.set(key, value);
            },
            async remove(key) {
                storage.delete(key);
            },
        },
    },
};

const context = vm.createContext({
    browser: api,
    console,
    fetch,
    Blob,
    URL,
    DOMException,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    performance,
});

for (const script of scripts) {
    vm.runInContext(readFileSync(path.join(sourceDir, script), 'utf8'), context, { filename: script });
}

if (!runtimeListener) throw new Error('background-core did not register a runtime listener');

function send(message, sender = { tab: { id: 7 } }) {
    return new Promise((resolve) => {
        const returned = runtimeListener(message, sender, resolve);
        if (returned !== true) resolve(undefined);
    });
}

async function waitFor(type, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const found = relayed.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${type}. Got: ${relayed.map((m) => m.type).join(', ')}`);
}

const single = await send({ type: 'pr:start', panoid: goodPano, width: 10240, height: 5120, zoom: 3 });
if (!single || !single.ok) throw new Error(`Single download did not start: ${JSON.stringify(single)}`);

const done = await waitFor('pr:done');
if (done.filename !== `streetview_${goodPano}_3328x1664.jpg`) {
    throw new Error(`Unexpected filename: ${done.filename}`);
}
if (!relayed.some((message) => message.type === 'pr:progress' && message.total > 0)) {
    throw new Error('No progress was relayed to the tab.');
}
if (downloads[0].filename !== done.filename) throw new Error('Downloads call did not use the stitched filename.');
console.log('firefox single:', done.filename, done.size);

const batch = await send({ type: 'pr:begin-batch', panoids: [goodPano, badPano], zoom: 3 });
if (!batch || !batch.ok) throw new Error(`Batch download did not start: ${JSON.stringify(batch)}`);

const batchDone = await waitFor('pr:batch-done');
if (batchDone.count !== 2 || batchDone.saved !== 1 || batchDone.failures !== 1) {
    throw new Error(`Unexpected batch result: ${JSON.stringify(batchDone)}`);
}
const batchDownload = downloads.find((options) => options.filename.startsWith('peerRipper/'));
if (!batchDownload || batchDownload.filename !== `peerRipper/001_${goodPano}_3328x1664.jpg`) {
    throw new Error(`Unexpected batch download: ${JSON.stringify(batchDownload)}`);
}
if (storage.size !== 0) throw new Error(`Active job was not cleared: ${JSON.stringify([...storage])}`);
console.log('firefox batch:', `${batchDone.saved}/${batchDone.count}`, batchDownload.filename);
console.log('PASS');
process.exit(0);
