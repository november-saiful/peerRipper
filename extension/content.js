(() => {
    if (window.__peerripperContent) return;
    window.__peerripperContent = true;

    const ZOOM_NAMES = { 5: 'Original', 4: 'Half', 3: 'Quarter' };
    const PANOID_PATTERN = /^[A-Za-z0-9_-]{18,28}$/;
    const ROUTE_KEY = '__peerripper_route_v1';
    const MAX_ROUTE = 500;
    const api = globalThis.peerRipperApi;
    const iconUrl = api.runtime.getURL('icons/icon48.png');

    const state = {
        panoid: null,
        dims: null,
        open: false,
        running: false,
        batch: false,
        recording: false,
        route: [],
        jobId: null,
        progress: null,
        result: null,
        error: null,
    };

    // ---------------------------------------------------------------- discovery

    function urlText() {
        const href = location.href;
        try {
            return decodeURIComponent(href);
        } catch {
            return href;
        }
    }

    function dimsFromUrl(text) {
        const match = text.match(/!7i(\d+)!8i(\d+)/);
        if (!match) return null;
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width < 512 || height < 256 || width > 65536 || height > 32768) return null;
        return { width, height };
    }

    function panoidFromUrl(text) {
        const pattern = /[!?&]1s([A-Za-z0-9_-]{18,28})/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const id = match[1];
            if (/^0x/i.test(id) || /^(ChIJ|GhIJ|EhIJ)/.test(id)) continue;
            return id;
        }
        const query = text.match(/[?&]panoid=([A-Za-z0-9_-]{18,28})/);
        return query ? query[1] : null;
    }

    function panoidFromTiles() {
        const entries = performance.getEntriesByType('resource');
        const first = Math.max(0, entries.length - 400);
        for (let i = entries.length - 1; i >= first; i--) {
            const name = entries[i].name;
            if (name.indexOf('/v1/tile') < 0 || name.indexOf('panoid=') < 0) continue;
            const match = name.match(/[?&]panoid=([A-Za-z0-9_-]{18,28})/);
            if (match) return match[1];
        }
        return null;
    }

    // ---------------------------------------------------------------- route

    function loadRoute() {
        try {
            const saved = JSON.parse(sessionStorage.getItem(ROUTE_KEY) || 'null');
            if (!saved || !Array.isArray(saved.route)) return;
            state.route = saved.route.filter((panoid) => PANOID_PATTERN.test(panoid)).slice(0, MAX_ROUTE);
            state.recording = Boolean(saved.recording);
        } catch {
            state.route = [];
            state.recording = false;
        }
    }

    function saveRoute() {
        try {
            sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ recording: state.recording, route: state.route }));
        } catch {
            // Storage can be unavailable; the route still works for this page session.
        }
    }

    function remember(panoid) {
        if (!panoid || !state.recording) return;
        if (state.route.includes(panoid)) return;
        if (state.route.length >= MAX_ROUTE) {
            state.recording = false;
            state.error = `Route limit reached (${MAX_ROUTE} panoramas). Download or clear the route to continue.`;
            saveRoute();
            return;
        }
        state.route.push(panoid);
        saveRoute();
    }

    // ---------------------------------------------------------------- ui

    const host = document.createElement('div');
    host.id = 'peerripper-root';
    const root = host.attachShadow({ mode: 'open' });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
        :host { all: initial; }
        .pill, .card { position: fixed; right: 16px; bottom: 122px; z-index: 2147483647; }
        [hidden] { display: none !important; }
        .pill {
            display: flex; align-items: center; gap: 9px;
            padding: 7px 14px 7px 8px; border: 0; border-radius: 999px;
            background: #ffffff; color: #1d2b18; cursor: pointer;
            font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
            box-shadow: 0 2px 5px rgba(18, 38, 8, 0.2), 0 10px 28px rgba(18, 38, 8, 0.22);
        }
        .pill:hover { background: #f4faec; }
        .pill:active { transform: translateY(1px); }
        .mark { width: 28px; height: 28px; display: block; flex: none; position: relative; }
        .mark img { width: 100%; height: 100%; display: block; }
        .mark svg { display: none; width: 100%; height: 100%; }
        .mark.failed img { display: none; }
        .mark.failed svg { display: block; }
        .card {
            width: 276px; box-sizing: border-box; padding: 14px;
            border-radius: 16px; background: #ffffff; color: #1d2b18;
            font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
            box-shadow: 0 2px 6px rgba(18, 38, 8, 0.16), 0 14px 40px rgba(18, 38, 8, 0.26);
        }
        header { display: flex; align-items: center; gap: 10px; }
        header .mark { width: 34px; height: 34px; }
        .titles { flex: 1; min-width: 0; }
        h1 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: 0.1px; }
        .sub { margin: 1px 0 0; font-size: 11px; color: #6d7b66; }
        .close {
            border: 0; background: transparent; color: #77836f; cursor: pointer;
            width: 26px; height: 26px; border-radius: 8px; font-size: 13px; line-height: 1;
        }
        .close:hover { background: #eef3e9; color: #37452f; }
        .controls { display: flex; gap: 8px; margin-top: 13px; }
        select, .go { height: 34px; box-sizing: border-box; border-radius: 9px; font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
        select {
            flex: 1; min-width: 0; padding: 0 8px; cursor: pointer;
            border: 1px solid #d6dfcd; background: #f7faf3; color: #2c3a25;
        }
        select:disabled { opacity: 0.55; cursor: default; }
        .go {
            padding: 0 15px; border: 0; cursor: pointer; color: #ffffff;
            background: #6aa842;
        }
        .go:hover { background: #5d953a; }
        .go:disabled { background: #b9c8ae; cursor: default; }
        .go.cancel { background: #eef0ec; color: #3c4736; }
        .go.cancel:hover { background: #e3e7df; }
        .progress {
            display: none; margin-top: 11px; height: 4px; border-radius: 999px;
            background: #e9efe3; overflow: hidden;
        }
        .progress.on { display: block; }
        .progress i {
            display: block; height: 100%; width: 0; border-radius: inherit;
            background: #7ab34f; transition: width 120ms linear;
        }
        .progress.on:not(.determinate) i { width: 35% !important; animation: slide 1.1s ease-in-out infinite; }
        @keyframes slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(320%); }
        }
        .note { margin: 9px 1px 0; font-size: 11.5px; color: #6d7b66; word-break: break-word; }
        .note.error { color: #b3261e; }
        .route { display: flex; gap: 8px; margin-top: 8px; }
        .route button {
            flex: 1; height: 30px; padding: 0 8px; border-radius: 9px; cursor: pointer;
            border: 1px solid #d6dfcd; background: #f7faf3; color: #2c3a25;
            font: 600 11.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .route button:hover:not(:disabled) { background: #eef4e7; }
        .route button:disabled { opacity: 0.55; cursor: default; }
        .route .record.on { background: #fdeceb; border-color: #f2c6c2; color: #b3261e; }
    `);
    root.adoptedStyleSheets = [sheet];

    const handSvg = `
        <svg viewBox="0 0 64 64" aria-hidden="true">
            <g fill="#86bf4d" stroke="#2f3a20" stroke-width="3" stroke-linejoin="round">
                <rect x="21" y="11" width="9.5" height="24" rx="4.75"/>
                <rect x="31" y="7" width="9.5" height="28" rx="4.75"/>
                <rect x="41" y="11" width="9.5" height="24" rx="4.75"/>
                <rect x="50" y="18" width="9" height="17" rx="4.5" transform="rotate(14 54.5 26.5)"/>
                <path d="M15 33 C15 27 20 23 26 23 L47 23 C52 23 56 27 56 33 L56 41 C56 51 48 58 38 58 L33 58 C24 58 16 51 16 41 Z"/>
                <rect x="5" y="30" width="10.5" height="18" rx="5.25" transform="rotate(-32 10 39)"/>
            </g>
        </svg>`;

    const mark = (size) => `<span class="mark">${handSvg}</span>`;

    const template = new DOMParser().parseFromString(
        `<div>
            <button class="pill" type="button">${mark()}<span>Download panorama</span></button>
            <section class="card" hidden>
                <header>
                    ${mark()}
                    <div class="titles">
                        <h1>peerRipper</h1>
                        <p class="sub">Street View panorama</p>
                    </div>
                    <button class="close" type="button" title="Close">&#10005;</button>
                </header>
                <div class="controls">
                    <select class="zoom" title="Resolution">
                        <option value="5">Original</option>
                        <option value="4">Half</option>
                        <option value="3">Quarter</option>
                    </select>
                    <button class="go" type="button">Download</button>
                </div>
                <div class="route">
                    <button class="record" type="button">Record route</button>
                    <button class="batch" type="button" disabled>Download all</button>
                </div>
                <div class="progress"><i></i></div>
                <p class="note"></p>
            </section>
        </div>`,
        'text/html',
    );
    root.append(...Array.from(template.body.firstElementChild.childNodes));

    const marks = root.querySelectorAll('.mark');
    const pill = root.querySelector('.pill');
    const card = root.querySelector('.card');
    const closeButton = root.querySelector('.close');
    const zoomSelect = root.querySelector('.zoom');
    const goButton = root.querySelector('.go');
    const recordButton = root.querySelector('.record');
    const batchButton = root.querySelector('.batch');
    const progress = root.querySelector('.progress');
    const progressFill = progress.querySelector('i');
    const note = root.querySelector('.note');

    for (const element of marks) {
        const img = document.createElement('img');
        img.src = iconUrl;
        img.alt = '';
        img.addEventListener('error', () => element.classList.add('failed'));
        element.appendChild(img);
    }

    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup', 'wheel']) {
        host.addEventListener(type, (event) => event.stopPropagation());
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function noteText() {
        if (state.error) return state.error;
        if (state.running) {
            const progress = state.progress || { phase: 'starting' };
            const count = state.batch ? progress.count || state.route.length : 0;
            const prefix = count ? `Panorama ${Math.min((progress.index || 0) + 1, count)} / ${count} · ` : '';
            if (progress.phase === 'checking') return `${prefix}checking panorama…`;
            if (progress.phase === 'downloading') {
                if (!progress.total) return `${prefix}starting…`;
                if (progress.width) return `${prefix}${progress.width} × ${progress.height} · ${progress.done} / ${progress.total} tiles`;
                return `${prefix}${progress.done} / ${progress.total} tiles · ${formatBytes(progress.bytes || 0)}`;
            }
            if (progress.phase === 'stitching') return `${prefix}stitching JPEG…`;
            if (progress.phase === 'saving') return `${prefix}saving…`;
            if (progress.phase === 'skipping') return `${prefix}unavailable, skipping…`;
            return `${prefix}working…`;
        }
        if (state.result) return state.result;
        if (!state.panoid) return 'Open a panorama in Street View to download it.';
        if (state.recording) {
            const count = state.route.length;
            return `Recording · ${count} panorama${count === 1 ? '' : 's'} captured. Move along the route.`;
        }
        const zoom = Number(zoomSelect.value) || 5;
        return `${ZOOM_NAMES[zoom]} resolution · JPEG`;
    }

    function sync() {
        pill.hidden = state.open;
        card.hidden = !state.open;
        if (!state.open) return;

        goButton.disabled = !state.panoid && !state.running;
        goButton.textContent = state.running ? 'Cancel' : 'Download';
        goButton.classList.toggle('cancel', state.running);
        zoomSelect.disabled = state.running;
        recordButton.disabled = state.running;
        recordButton.textContent = state.recording ? 'Stop recording' : 'Record route';
        recordButton.classList.toggle('on', state.recording);
        batchButton.textContent = state.route.length ? `Download all (${state.route.length})` : 'Download all';
        batchButton.disabled = state.running || state.route.length === 0;

        progress.classList.toggle('on', state.running && Boolean(state.progress));
        const determinate = Boolean(state.progress && state.progress.total);
        progress.classList.toggle('determinate', determinate);
        progressFill.style.width = determinate
            ? `${Math.min(100, Math.round((state.progress.done * 100) / state.progress.total))}%`
            : '35%';

        note.textContent = noteText();
        note.classList.toggle('error', Boolean(state.error));
    }

    function refresh() {
        const text = urlText();
        const urlDims = dimsFromUrl(text);
        const urlPano = panoidFromUrl(text);
        const tilePano = panoidFromTiles();
        const nextPano = tilePano || (urlPano && urlDims ? urlPano : null);
        const nextDims = nextPano && urlPano === nextPano ? urlDims : null;

        if (nextPano !== state.panoid) {
            state.panoid = nextPano;
            state.dims = nextDims;
            if (!state.running) {
                state.result = null;
                state.error = null;
            }
            remember(nextPano);
            sync();
            return;
        }
        if (nextDims && (!state.dims || nextDims.width !== state.dims.width || nextDims.height !== state.dims.height)) {
            state.dims = nextDims;
            sync();
        }
    }

    function startDownload() {
        if (!state.panoid || state.running) return;
        state.running = true;
        state.batch = false;
        state.progress = { phase: 'checking', done: 0, total: 0, bytes: 0 };
        state.error = null;
        state.result = null;
        sync();

        api.runtime
            .sendMessage({
                type: 'pr:start',
                panoid: state.panoid,
                width: state.dims ? state.dims.width : 0,
                height: state.dims ? state.dims.height : 0,
                zoom: Number(zoomSelect.value),
            })
            .then((response) => {
                if (!response || !response.ok) {
                    throw new Error((response && response.error) || 'Could not start the download.');
                }
                state.jobId = response.jobId;
            })
            .catch((error) => {
                state.running = false;
                state.progress = null;
                state.error = (error && error.message) || 'Could not start the download.';
                sync();
            });
    }

    function startBatchDownload() {
        if (state.running || !state.route.length) return;
        state.running = true;
        state.batch = true;
        state.open = true;
        state.progress = { phase: 'checking', done: 0, total: 0, bytes: 0, index: 0, count: state.route.length };
        state.error = null;
        state.result = null;
        sync();

        api.runtime
            .sendMessage({ type: 'pr:begin-batch', panoids: state.route.slice(), zoom: Number(zoomSelect.value) })
            .then((response) => {
                if (!response || !response.ok) {
                    throw new Error((response && response.error) || 'Could not start the batch download.');
                }
                state.jobId = response.jobId;
            })
            .catch((error) => {
                state.running = false;
                state.batch = false;
                state.progress = null;
                state.error = (error && error.message) || 'Could not start the batch download.';
                sync();
            });
    }

    function cancelDownload() {
        api.runtime.sendMessage({ type: 'pr:cancel', jobId: state.jobId }).catch(() => {});
        state.error = null;
        state.result = 'Cancelling…';
        sync();
    }

    pill.addEventListener('click', () => {
        state.open = true;
        refresh();
        sync();
    });
    closeButton.addEventListener('click', () => {
        state.open = false;
        sync();
    });
    goButton.addEventListener('click', () => {
        if (state.running) cancelDownload();
        else startDownload();
    });
    zoomSelect.addEventListener('change', sync);
    recordButton.addEventListener('click', () => {
        state.recording = !state.recording;
        if (state.recording) {
            state.error = null;
            remember(state.panoid);
        }
        saveRoute();
        sync();
    });
    batchButton.addEventListener('click', startBatchDownload);

    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.type !== 'string') return;

        if (message.type === 'pr:probe') {
            refresh();
            sendResponse({
                panoid: state.panoid,
                running: state.running,
                batch: state.batch,
                recording: state.recording,
                routeCount: state.route.length,
                progress: state.progress,
                result: state.result,
                error: state.error,
            });
            return;
        }
        if (message.type === 'pr:set-recording') {
            state.recording = Boolean(message.on);
            if (state.recording) {
                state.error = null;
                remember(state.panoid);
            }
            saveRoute();
            sync();
            sendResponse({ ok: true, recording: state.recording, routeCount: state.route.length });
            return;
        }
        if (message.type === 'pr:start-batch') {
            if (message.zoom) zoomSelect.value = String(message.zoom);
            refresh();
            startBatchDownload();
            sendResponse({ ok: state.running, error: state.running ? null : 'Record a route first.' });
            return;
        }
        if (message.type === 'pr:open-and-start') {
            if (message.zoom) zoomSelect.value = String(message.zoom);
            state.open = true;
            refresh();
            sync();
            startDownload();
            sendResponse({ ok: Boolean(state.panoid), error: state.panoid ? null : 'No panorama found in this tab.' });
            return;
        }
        if (message.type === 'pr:open') {
            state.open = true;
            refresh();
            sync();
            sendResponse({ ok: true });
            return;
        }
        if (message.type === 'pr:request-cancel') {
            if (state.running) cancelDownload();
            sendResponse({ ok: true });
            return;
        }

        if (message.type === 'pr:progress') {
            state.running = true;
            if (message.count > 0) state.batch = true;
            state.progress = {
                phase: message.phase,
                done: message.done || 0,
                total: message.total || 0,
                bytes: message.bytes || 0,
                width: message.width || 0,
                height: message.height || 0,
                index: message.index || 0,
                count: message.count || 0,
            };
            state.error = null;
            sync();
        } else if (message.type === 'pr:done') {
            state.running = false;
            state.batch = false;
            state.progress = null;
            state.error = null;
            state.result = `Saved ${message.filename}`;
            sync();
        } else if (message.type === 'pr:batch-done') {
            state.running = false;
            state.batch = false;
            state.progress = null;
            if (!message.saved) {
                state.error = 'No panoramas in this route could be downloaded.';
                state.result = null;
            } else {
                state.error = null;
                state.result = Number(message.failures)
                    ? `Saved ${message.saved} of ${message.count} · ${message.failures} unavailable — peerRipper/`
                    : `Saved ${message.saved} panorama${message.saved === 1 ? '' : 's'} — peerRipper/`;
            }
            sync();
        } else if (message.type === 'pr:failed') {
            state.running = false;
            state.progress = null;
            state.error = message.error || 'The download failed.';
            sync();
        } else if (message.type === 'pr:cancelled') {
            state.running = false;
            state.batch = false;
            state.progress = null;
            state.error = null;
            state.result = 'Cancelled.';
            sync();
        }
    });

    document.documentElement.appendChild(host);

    loadRoute();
    refresh();
    sync();

    api.runtime
        .sendMessage({ type: 'pr:status' })
        .then((response) => {
            if (!response || !response.active) return;
            if (response.panoid && state.panoid && response.panoid !== state.panoid) return;
            state.running = true;
            state.batch = Boolean(response.batch);
            state.progress = response.progress;
            sync();
        })
        .catch(() => {});

    setInterval(refresh, 1000);
    try {
        new PerformanceObserver(() => refresh()).observe({ type: 'resource' });
    } catch {
        // Older browsers: the polling interval still picks up tile requests.
    }
    window.addEventListener('popstate', refresh);
    window.addEventListener('hashchange', refresh);
})();
