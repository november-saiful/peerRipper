// Chromium bridge: the service worker cannot create blob URLs, so downloads run in
// an offscreen document.
(() => {
    const api = globalThis.PeerRipperApi;
    const OFFSCREEN_URL = 'offscreen.html';

    let offscreenPromise = null;

    async function ensureOffscreen() {
        if (!offscreenPromise) {
            offscreenPromise = (async () => {
                if (await api.offscreen.hasDocument()) return;
                await api.offscreen.createDocument({
                    url: OFFSCREEN_URL,
                    reasons: ['BLOBS'],
                    justification: 'Fetch Street View tiles and stitch them into a single JPEG file.',
                });
            })().catch((error) => {
                offscreenPromise = null;
                throw error;
            });
        }
        return offscreenPromise;
    }

    async function sendToOffscreen(message) {
        await ensureOffscreen();
        for (let attempt = 0; ; attempt++) {
            try {
                return await api.runtime.sendMessage(message);
            } catch (error) {
                if (attempt >= 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }
    }

    async function start(message) {
        try {
            return await sendToOffscreen(message);
        } catch {
            return { ok: false, error: 'Could not start the download engine.' };
        }
    }

    globalThis.PeerRipperBridge = {
        startJob(job) {
            return start({ type: 'pr:run', job });
        },
        startBatch(job) {
            return start({ type: 'pr:run-batch', job });
        },
        async cancel(jobId) {
            try {
                await api.runtime.sendMessage({ type: 'pr:cancel', jobId });
            } catch {
                // The offscreen document is not running, so nothing is downloading.
            }
        },
        async revoke(url) {
            try {
                await api.runtime.sendMessage({ type: 'pr:revoke', url });
            } catch {
                // The offscreen document is gone; its blob URLs went with it.
            }
        },
    };
})();
