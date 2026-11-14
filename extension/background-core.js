(() => {
    const api = globalThis.peerRipperApi;
    const bridge = globalThis.peerRipperBridge;
    const PANOID_PATTERN = /^[A-Za-z0-9_-]{18,28}$/;
    const MAX_BATCH = 500;

    let activeJob;
    const blobUrls = new Map();
    const pendingNames = new Map();

    // Chromium ignores the filename option for blob: URLs, so the target name is
    // re-applied when the download manager asks for a filename.
    if (api.downloads.onDeterminingFilename) {
        api.downloads.onDeterminingFilename.addListener((item, suggest) => {
            const filename = pendingNames.get(item.url) || pendingNames.get(item.finalUrl);
            if (!filename) {
                suggest();
                return;
            }
            pendingNames.delete(item.url);
            pendingNames.delete(item.finalUrl);
            suggest({ filename, conflictAction: 'uniquify' });
        });
    }

    async function getActiveJob() {
        if (activeJob !== undefined) return activeJob;
        const stored = await api.storage.session.get('activeJob');
        activeJob = stored.activeJob ?? null;
        return activeJob;
    }

    async function setActiveJob(job) {
        activeJob = job;
        if (job) await api.storage.session.set({ activeJob: job });
        else await api.storage.session.remove('activeJob');
    }

    async function relayToTab(job, message) {
        try {
            await api.tabs.sendMessage(job.tabId, message);
        } catch {
            // The Maps tab is gone or was reloaded away from the content script.
        }
    }

    async function handleStart(message, tabId) {
        const panoid = String(message.panoid || '');
        if (!PANOID_PATTERN.test(panoid)) return { ok: false, error: 'No panorama is open in this tab.' };
        const zoom = Number(message.zoom);
        if (!(zoom >= 3 && zoom <= 5)) return { ok: false, error: 'Unsupported resolution.' };

        const current = await getActiveJob();
        if (current) return { ok: false, error: 'Another download is already running.' };

        const job = {
            id: crypto.randomUUID(),
            tabId,
            panoid,
            zoom,
            width: Math.max(0, Number(message.width) || 0),
            height: Math.max(0, Number(message.height) || 0),
            progress: null,
        };
        await setActiveJob(job);

        let response;
        try {
            response = await bridge.startJob({ ...job, progress: undefined }, dispatchEngine);
        } catch {
            await setActiveJob(null);
            return { ok: false, error: 'Could not start the download engine.' };
        }
        if (!response || !response.ok) {
            await setActiveJob(null);
            return { ok: false, error: (response && response.error) || 'Could not start the download.' };
        }
        return { ok: true, jobId: job.id };
    }

    async function handleStartBatch(message, tabId) {
        const raw = Array.isArray(message.panoids) ? message.panoids : [];
        const panoids = [...new Set(raw.map((value) => String(value)))];
        if (!panoids.length) return { ok: false, error: 'Record a route first.' };
        if (panoids.length > MAX_BATCH) return { ok: false, error: `A route can hold at most ${MAX_BATCH} panoramas.` };
        if (!panoids.every((panoid) => PANOID_PATTERN.test(panoid))) {
            return { ok: false, error: 'The recorded route is not valid.' };
        }
        const zoom = Number(message.zoom);
        if (!(zoom >= 3 && zoom <= 5)) return { ok: false, error: 'Unsupported resolution.' };

        const current = await getActiveJob();
        if (current) return { ok: false, error: 'Another download is already running.' };

        const job = { id: crypto.randomUUID(), tabId, panoids, zoom, batch: true, progress: null };
        await setActiveJob(job);

        let response;
        try {
            response = await bridge.startBatch({ id: job.id, panoids, zoom }, dispatchEngine);
        } catch {
            await setActiveJob(null);
            return { ok: false, error: 'Could not start the download engine.' };
        }
        if (!response || !response.ok) {
            await setActiveJob(null);
            return { ok: false, error: (response && response.error) || 'Could not start the batch download.' };
        }
        return { ok: true, jobId: job.id };
    }

    async function handleProgress(message) {
        const job = await getActiveJob();
        if (!job || job.id !== message.jobId) return;
        job.progress = {
            phase: message.phase || 'downloading',
            done: Number(message.done) || 0,
            total: Number(message.total) || 0,
            bytes: Number(message.bytes) || 0,
            width: Number(message.width) || 0,
            height: Number(message.height) || 0,
            index: Number(message.index) || 0,
            count: Number(message.count) || 0,
        };
        if (job.progress.phase !== job.savedPhase) {
            job.savedPhase = job.progress.phase;
            await api.storage.session.set({ activeJob: job });
        }
        await relayToTab(job, { type: 'pr:progress', ...job.progress });
    }

    async function handleDone(message) {
        const job = await getActiveJob();
        if (!job || job.id !== message.jobId) return;

        try {
            pendingNames.set(message.url, message.filename);
            const downloadId = await api.downloads.download({
                url: message.url,
                filename: message.filename,
                saveAs: false,
                conflictAction: 'uniquify',
            });
            blobUrls.set(downloadId, message.url);
            await relayToTab(job, { type: 'pr:done', filename: message.filename, size: message.size });
        } catch (error) {
            pendingNames.delete(message.url);
            await bridge.revoke(message.url);
            const text = error && error.message ? error.message : 'the download could not be started';
            await relayToTab(job, { type: 'pr:failed', error: `Could not save the file: ${text}` });
        }
        await setActiveJob(null);
    }

    async function handleItem(message) {
        const job = await getActiveJob();
        if (!job || job.id !== message.jobId) {
            await bridge.revoke(message.url);
            return;
        }
        try {
            pendingNames.set(message.url, message.filename);
            const downloadId = await api.downloads.download({
                url: message.url,
                filename: message.filename,
                saveAs: false,
                conflictAction: 'uniquify',
            });
            blobUrls.set(downloadId, message.url);
            job.saved = (job.saved || 0) + 1;
            await api.storage.session.set({ activeJob: job });
        } catch {
            pendingNames.delete(message.url);
            await bridge.revoke(message.url);
        }
    }

    async function handleBatchDone(message) {
        const job = await getActiveJob();
        if (!job || job.id !== message.jobId) return;
        await relayToTab(job, {
            type: 'pr:batch-done',
            count: message.count,
            saved: message.saved,
            failures: message.failures,
            error: message.error,
        });
        await setActiveJob(null);
    }

    async function handleFailure(message, cancelled) {
        const job = await getActiveJob();
        if (!job || job.id !== message.jobId) return;
        await relayToTab(job, cancelled ? { type: 'pr:cancelled' } : { type: 'pr:failed', error: message.error });
        await setActiveJob(null);
    }

    // Engine messages must be applied in the order they were produced, otherwise a
    // trailing progress update can land after the completion message.
    let engineQueue = Promise.resolve();
    function sequence(task) {
        engineQueue = engineQueue.then(task).catch(() => {});
        return engineQueue;
    }

    // Chromium delivers engine messages through runtime messaging; the Firefox bridge
    // calls this directly from the background page.
    function dispatchEngine(message) {
        switch (message.type) {
            case 'pr:progress':
                sequence(() => handleProgress(message));
                return;
            case 'pr:done':
                sequence(() => handleDone(message));
                return;
            case 'pr:item':
                sequence(() => handleItem(message));
                return;
            case 'pr:batch-done':
                sequence(() => handleBatchDone(message));
                return;
            case 'pr:failed':
                sequence(() => handleFailure(message, false));
                return;
            case 'pr:cancelled':
                sequence(() => handleFailure(message, true));
                return;
            default:
                return;
        }
    }

    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.type !== 'string' || !message.type.startsWith('pr:')) return;

        switch (message.type) {
            case 'pr:start':
                if (!sender.tab) return;
                handleStart(message, sender.tab.id).then(sendResponse);
                return true;
            case 'pr:begin-batch':
                if (!sender.tab) return;
                handleStartBatch(message, sender.tab.id).then(sendResponse);
                return true;
            case 'pr:status':
                if (!sender.tab) return;
                getActiveJob().then((job) => {
                    const mine = job && job.tabId === sender.tab.id;
                    sendResponse({
                        active: Boolean(mine),
                        panoid: mine ? job.panoid : null,
                        batch: Boolean(mine && job.batch),
                        progress: mine ? job.progress : null,
                    });
                });
                return true;
            case 'pr:cancel':
                getActiveJob().then(async (job) => {
                    if (!job) return sendResponse({ ok: false });
                    await bridge.cancel(job.id);
                    sendResponse({ ok: true });
                });
                return true;
            case 'pr:progress':
            case 'pr:done':
            case 'pr:item':
            case 'pr:batch-done':
            case 'pr:failed':
            case 'pr:cancelled':
                if (!sender.tab) dispatchEngine(message);
                return;
            default:
                return;
        }
    });

    api.downloads.onChanged.addListener((delta) => {
        if (!delta.state) return;
        const url = blobUrls.get(delta.id);
        if (!url) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
            blobUrls.delete(delta.id);
            bridge.revoke(url);
        }
    });
})();
