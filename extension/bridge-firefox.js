// Firefox bridge: background pages have DOM and blob support, so the engine runs
// inline instead of in an offscreen document.
(() => {
    const engine = globalThis.peerRipperEngine;

    globalThis.peerRipperBridge = {
        startJob(job, dispatch) {
            if (engine.isBusy()) return Promise.resolve({ ok: false, error: 'Another download is already running.' });
            engine.startJob(job, dispatch).catch(() => {});
            return Promise.resolve({ ok: true });
        },
        startBatch(job, dispatch) {
            if (engine.isBusy()) return Promise.resolve({ ok: false, error: 'Another download is already running.' });
            engine.startBatch(job, dispatch).catch(() => {});
            return Promise.resolve({ ok: true });
        },
        cancel(jobId) {
            engine.cancel(jobId);
            return Promise.resolve({ ok: true });
        },
        revoke(url) {
            engine.revoke(url);
        },
    };
})();
