(() => {
    const TILE_SIZE = 512;
    const MAX_ZOOM = 5;
    const CONCURRENCY = 8;
    const UNAVAILABLE =
        "This panorama isn't served as Street View tiles. Photo spheres and some user uploads can't be downloaded this way.";

    const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

    const createdUrls = new Set();
    let active = null;

    function abortError() {
        return new DOMException('Cancelled', 'AbortError');
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                reject(abortError());
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function tileUrl(panoid, x, y, zoom) {
        return (
            'https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=apiv3&output=tile&panoid=' +
            encodeURIComponent(panoid) +
            `&x=${x}&y=${y}&zoom=${zoom}`
        );
    }

    function jpegComponentCount(bytes) {
        if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 0;
        const n = bytes.length;
        let i = 2;
        while (i + 1 < n) {
            if (bytes[i] !== 0xff) {
                i++;
                continue;
            }
            while (i < n && bytes[i] === 0xff) i++;
            if (i >= n) break;
            const marker = bytes[i++];
            if (marker === 0x00) continue;
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
            if (marker === 0xda) break;
            if (i + 2 > n) break;
            const length = (bytes[i] << 8) | bytes[i + 1];
            if (length < 2 || i + length > n) break;
            const isSof =
                (marker >= 0xc0 && marker <= 0xc3) ||
                (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) ||
                (marker >= 0xcd && marker <= 0xcf);
            if (isSof) return i + 7 < n ? bytes[i + 7] : 0;
            i += length;
        }
        return 0;
    }

    async function fetchTile(panoid, x, y, zoom, signal) {
        const url = tileUrl(panoid, x, y, zoom);
        for (let attempt = 0; ; attempt++) {
            let retry = false;
            try {
                const response = await fetch(url, { signal, credentials: 'omit' });
                if (response.ok) return new Uint8Array(await response.arrayBuffer());
                if (response.status === 400 || response.status === 404) throw new Error(UNAVAILABLE);
                if (RETRYABLE_STATUS.has(response.status)) retry = true;
                else throw new Error(`Tile service returned HTTP ${response.status}.`);
            } catch (error) {
                if (signal.aborted || !(error instanceof TypeError)) throw error;
                retry = true;
            }
            if (!retry || attempt >= 3) throw new Error('A tile could not be downloaded. Check your connection and try again.');
            await sleep(350 * (attempt + 1), signal);
        }
    }

    async function fetchStatus(panoid, x, y, zoom, signal) {
        const url = tileUrl(panoid, x, y, zoom);
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await fetch(url, { signal, credentials: 'omit' });
                return {
                    status: response.status,
                    bytes: response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
                };
            } catch (error) {
                if (signal.aborted) throw error;
                if (attempt >= 3) throw new Error('Could not reach the Street View tile service.');
                await sleep(400 * (attempt + 1), signal);
            }
        }
    }

    // Tile coverage is what Google actually serves at maximum zoom; the !7i/!8i hints in
    // Maps URLs are the source photo size and can be smaller than the tile canvas.
    async function findLastIndex(panoid, axis, hint, signal) {
        const exists = async (index) => {
            const x = axis === 'x' ? index : 0;
            const y = axis === 'x' ? 0 : index;
            const result = await fetchStatus(panoid, x, y, MAX_ZOOM, signal);
            if (result.status === 400 || result.status === 404) return false;
            return result.status === 200 && jpegComponentCount(result.bytes) === 3;
        };

        if (!(await exists(0))) throw new Error(UNAVAILABLE);

        let good = 0;
        const step = Math.max(1, Math.min(hint, 64));
        if (!(await exists(step))) {
            let bad = step;
            while (bad - good > 1) {
                const mid = (good + bad) >> 1;
                if (await exists(mid)) good = mid;
                else bad = mid;
            }
            return good;
        }

        good = step;
        let bad = step * 2;
        while (bad <= 512 && (await exists(bad))) {
            good = bad;
            bad *= 2;
        }
        if (bad > 512) return good;
        while (bad - good > 1) {
            const mid = (good + bad) >> 1;
            if (await exists(mid)) good = mid;
            else bad = mid;
        }
        return good;
    }

    async function probeCanvas(panoid, hintWidth, hintHeight, signal) {
        const hintCols = Math.max(1, Math.ceil((hintWidth || 2048) / TILE_SIZE));
        const hintRows = Math.max(1, Math.ceil((hintHeight || 1024) / TILE_SIZE));
        const cols = (await findLastIndex(panoid, 'x', hintCols, signal)) + 1;
        const rows = (await findLastIndex(panoid, 'y', hintRows, signal)) + 1;
        return { width: cols * TILE_SIZE, height: rows * TILE_SIZE };
    }

    function clampZoom(value) {
        return Math.min(MAX_ZOOM, Math.max(3, Number(value) || MAX_ZOOM));
    }

    async function downloadPano(panoid, zoom, signal, hint, onProgress) {
        onProgress({ phase: 'checking', done: 0, total: 0, bytes: 0 });
        const canvas = await probeCanvas(panoid, hint.width, hint.height, signal);
        const gridWidth = Math.max(1, canvas.width >> (MAX_ZOOM - zoom));
        const gridHeight = Math.max(1, canvas.height >> (MAX_ZOOM - zoom));
        const cols = Math.ceil(gridWidth / TILE_SIZE);
        const rows = Math.ceil(gridHeight / TILE_SIZE);
        const total = cols * rows;

        onProgress({ phase: 'downloading', done: 0, total, bytes: 0, width: gridWidth, height: gridHeight });

        const tiles = new Array(total);
        let next = 0;
        let done = 0;
        let bytes = 0;
        const worker = async () => {
            for (;;) {
                if (signal.aborted) throw abortError();
                const index = next++;
                if (index >= total) return;
                const data = await fetchTile(panoid, index % cols, Math.floor(index / cols), zoom, signal);
                if (jpegComponentCount(data) !== 3) {
                    throw new Error(
                        `Tile ${index % cols},${Math.floor(index / cols)} is unavailable. The panorama resolution may be wrong.`,
                    );
                }
                tiles[index] = data;
                done++;
                bytes += data.length;
                if (done === total || done % 4 === 0) {
                    onProgress({ phase: 'downloading', done, total, bytes, width: gridWidth, height: gridHeight });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

        onProgress({ phase: 'stitching', done: total, total, bytes, width: gridWidth, height: gridHeight });
        await sleep(0, signal);
        const output = stitchJpegTiles(tiles, cols, rows, gridWidth, gridHeight);

        onProgress({ phase: 'saving', done: total, total, bytes, width: gridWidth, height: gridHeight });
        const blob = new Blob([output], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        createdUrls.add(url);
        setTimeout(() => {
            if (createdUrls.delete(url)) URL.revokeObjectURL(url);
        }, 10 * 60 * 1000);
        return { url, size: output.length, width: gridWidth, height: gridHeight };
    }

    function makePost(jobId, dispatch) {
        return (payload) => dispatch({ ...payload, jobId });
    }

    async function runJob(job, dispatch, run) {
        const controller = new AbortController();
        active = { id: job.id, controller };
        const post = makePost(job.id, dispatch);
        try {
            await run(controller.signal, post);
        } catch (error) {
            if (controller.signal.aborted) post({ type: 'pr:cancelled' });
            else post({ type: 'pr:failed', error: error && error.message ? error.message : String(error) });
        } finally {
            active = null;
        }
    }

    async function startJob(job, dispatch) {
        await runJob(job, dispatch, async (signal, post) => {
            const result = await downloadPano(
                job.panoid,
                clampZoom(job.zoom),
                signal,
                { width: job.width, height: job.height },
                (progress) => post({ type: 'pr:progress', ...progress }),
            );
            post({
                type: 'pr:done',
                url: result.url,
                filename: `streetview_${job.panoid}_${result.width}x${result.height}.jpg`,
                size: result.size,
                width: result.width,
                height: result.height,
            });
        });
    }

    async function startBatch(job, dispatch) {
        const panoids = job.panoids;
        const count = panoids.length;
        const zoom = clampZoom(job.zoom);
        await runJob(job, dispatch, async (signal, post) => {
            let saved = 0;
            let bytes = 0;
            const failures = [];
            for (let index = 0; index < count; index++) {
                if (signal.aborted) throw abortError();
                try {
                    const result = await downloadPano(panoids[index], zoom, signal, { width: 0, height: 0 }, (progress) =>
                        post({ type: 'pr:progress', ...progress, index, count, bytes }),
                    );
                    saved++;
                    bytes += result.size;
                    post({
                        type: 'pr:item',
                        index,
                        count,
                        url: result.url,
                        filename: `PeerRipper/${String(index + 1).padStart(3, '0')}_${panoids[index]}_${result.width}x${result.height}.jpg`,
                        size: result.size,
                        width: result.width,
                        height: result.height,
                    });
                } catch (error) {
                    if (signal.aborted) throw error;
                    failures.push(panoids[index]);
                    post({ type: 'pr:progress', phase: 'skipping', index, count, done: 0, total: 0, bytes });
                }
            }
            post({
                type: 'pr:batch-done',
                count,
                saved,
                failures: failures.length,
                error: failures.length ? 'Some panoramas are not available through the web tile service.' : null,
                bytes,
            });
        });
    }

    function cancel(jobId) {
        if (active && active.id === jobId) active.controller.abort();
    }

    function revoke(url) {
        if (createdUrls.delete(url)) URL.revokeObjectURL(url);
    }

    function isBusy() {
        return Boolean(active);
    }

    globalThis.PeerRipperEngine = { startJob, startBatch, cancel, revoke, isBusy };
})();
