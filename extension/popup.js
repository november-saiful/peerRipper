const api = globalThis.PeerRipperApi;
const ZOOM_NAMES = { 5: 'Original', 4: 'Half', 3: 'Quarter' };
const POLL_MS = 800;

const el = {
    logo: document.getElementById('logo'),
    dot: document.getElementById('dot'),
    status: document.getElementById('status'),
    detail: document.getElementById('detail'),
    zoom: document.getElementById('zoom'),
    go: document.getElementById('go'),
    record: document.getElementById('record'),
    batch: document.getElementById('batch'),
    note: document.getElementById('note'),
};

let tabId = null;
let panoid = null;
let running = false;
let batch = false;
let recording = false;
let routeCount = 0;
let timer = null;

el.logo.src = api.runtime.getURL('icons/icon48.png');

function setStatus(text, tone) {
    el.status.textContent = text;
    el.dot.className = `dot${tone ? ` ${tone}` : ''}`;
}

function setDetail(text) {
    el.detail.textContent = text || '';
}

function progressText(progress) {
    if (!progress) return 'Starting…';
    const prefix = batch && progress.count
        ? `Panorama ${Math.min((progress.index || 0) + 1, progress.count)} / ${progress.count} · `
        : '';
    switch (progress.phase) {
        case 'checking':
            return `${prefix}detecting resolution…`;
        case 'downloading': {
            if (!progress.total) return `${prefix}starting…`;
            const dims = progress.width ? `${progress.width} × ${progress.height} · ` : '';
            return `${prefix}${dims}${progress.done} / ${progress.total} tiles`;
        }
        case 'stitching':
            return `${prefix}stitching JPEG…`;
        case 'saving':
            return `${prefix}saving file…`;
        case 'skipping':
            return `${prefix}unavailable, skipping…`;
        default:
            return `${prefix}working…`;
    }
}

function noteText() {
    if (running) {
        return batch
            ? `Downloading ${routeCount} panorama${routeCount === 1 ? '' : 's'} to PeerRipper/.`
            : 'Keep this tab open. The file goes to Downloads.';
    }
    if (!panoid) return 'Open Street View, then reopen PeerRipper.';
    if (recording) return `${routeCount} panorama${routeCount === 1 ? '' : 's'} captured. Move along the route.`;
    if (routeCount) {
        return `${routeCount} panorama${routeCount === 1 ? '' : 's'} recorded · ${ZOOM_NAMES[Number(el.zoom.value)]} resolution`;
    }
    return `${ZOOM_NAMES[Number(el.zoom.value)] || 'Original'} resolution · single stitched JPEG`;
}

function syncRoute() {
    el.record.textContent = recording ? 'Stop recording' : 'Record route';
    el.record.classList.toggle('on', recording);
    el.record.disabled = running || !panoid;
    el.batch.textContent = routeCount ? `Download all (${routeCount})` : 'Download all';
    el.batch.disabled = running || !routeCount;
}

function sync() {
    el.go.textContent = running ? 'Cancel' : 'Download';
    el.go.classList.toggle('cancel', running);
    el.go.disabled = !running && !panoid;
    el.zoom.disabled = running;
    syncRoute();
    el.note.textContent = noteText();
}

function apply(state) {
    if (!state || !state.reached) {
        running = false;
        batch = false;
        recording = false;
        routeCount = 0;
        panoid = null;
        setStatus("Can't read this tab", 'bad');
        setDetail('Reload the Google Maps page, then try again.');
        sync();
        return;
    }

    panoid = state.panoid || null;
    running = Boolean(state.running);
    batch = Boolean(state.batch);
    recording = Boolean(state.recording);
    routeCount = Number(state.routeCount) || 0;

    if (state.error) {
        running = false;
        setStatus('Download failed', 'bad');
        setDetail(state.error);
    } else if (running) {
        setStatus('Downloading…', 'busy');
        setDetail(progressText(state.progress));
    } else if (state.result === 'Cancelled.') {
        setStatus('Cancelled', 'bad');
        setDetail('No file was saved.');
    } else if (state.result && state.result.startsWith('Saved ')) {
        setStatus('Saved to Downloads', 'ok');
        setDetail(state.result.slice('Saved '.length));
    } else if (panoid) {
        setStatus('Panorama detected', 'ok');
        setDetail(panoid);
    } else {
        setStatus('No panorama found', 'bad');
        setDetail('Enter Street View in this tab, then reopen PeerRipper.');
    }
    sync();
}

function isMapsUrl(url) {
    try {
        const parsed = new URL(url);
        if (!/(^|\.)google\.[a-z]{2,}(\.[a-z]{2,})?$/.test(parsed.hostname)) return false;
        return parsed.pathname.startsWith('/maps') || parsed.hostname.startsWith('maps.');
    } catch {
        return false;
    }
}

function askTab(message) {
    return api.tabs
        .sendMessage(tabId, message)
        .then((response) => ({ reached: true, ...(response || {}) }))
        .catch(() => ({ reached: false }));
}

async function probe() {
    return await askTab({ type: 'pr:probe' });
}

async function refreshState() {
    const response = await probe();
    if (response.reached) {
        apply(response);
        return;
    }

    try {
        await api.scripting.executeScript({ target: { tabId }, files: ['api.js', 'content.js'] });
    } catch {
        apply({ reached: false });
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    apply(await probe());
}

async function init() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) {
        apply({ reached: false });
        return;
    }
    tabId = tab.id;

    if (tab.url && !isMapsUrl(tab.url)) {
        panoid = null;
        running = false;
        batch = false;
        recording = false;
        routeCount = 0;
        setStatus('Open Google Maps first', 'bad');
        setDetail('PeerRipper reads the live Street View panorama from the page.');
        sync();
        return;
    }

    setStatus('Looking for a panorama…');
    await refreshState();
    timer = setInterval(() => {
        askTab({ type: 'pr:probe' }).then((state) => {
            if (state.reached) apply(state);
        });
    }, POLL_MS);
}

el.go.addEventListener('click', async () => {
    if (running) {
        await askTab({ type: 'pr:request-cancel' });
        setStatus('Cancelling…', 'busy');
        return;
    }
    if (!panoid) return;

    running = true;
    batch = false;
    setStatus('Starting…', 'busy');
    setDetail('');
    sync();

    const response = await askTab({ type: 'pr:open-and-start', zoom: Number(el.zoom.value) });
    if (!response.reached) apply({ reached: false });
    else if (!response.ok) apply({ reached: true, panoid, error: response.error || 'Could not start the download.' });
});

el.record.addEventListener('click', async () => {
    if (!panoid) return;
    const response = await askTab({ type: 'pr:set-recording', on: !recording });
    if (!response.reached) {
        apply({ reached: false });
        return;
    }
    recording = Boolean(response.recording);
    routeCount = Number(response.routeCount) || routeCount;
    sync();
});

el.batch.addEventListener('click', async () => {
    if (running || !routeCount) return;
    running = true;
    batch = true;
    setStatus('Starting…', 'busy');
    setDetail('');
    sync();

    const response = await askTab({ type: 'pr:start-batch', zoom: Number(el.zoom.value) });
    if (!response.reached) {
        apply({ reached: false });
    } else if (!response.ok) {
        running = false;
        batch = false;
        setStatus('Could not start', 'bad');
        setDetail(response.error || 'Record a route first.');
        sync();
    }
});

el.zoom.addEventListener('change', sync);

window.addEventListener('unload', () => {
    if (timer) clearInterval(timer);
});

init();
