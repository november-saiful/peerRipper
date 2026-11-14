(() => {
    const engine = globalThis.peerRipperEngine;

    function post(payload) {
        chrome.runtime.sendMessage(payload).catch(() => {});
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.type !== 'string') return;

        switch (message.type) {
            case 'pr:run':
                if (engine.isBusy()) {
                    sendResponse({ ok: false, error: 'Another download is already running.' });
                    return;
                }
                engine.startJob(message.job, post).catch(() => {});
                sendResponse({ ok: true });
                return;
            case 'pr:run-batch': {
                if (engine.isBusy()) {
                    sendResponse({ ok: false, error: 'Another download is already running.' });
                    return;
                }
                const panoids = message.job && message.job.panoids;
                if (!Array.isArray(panoids) || !panoids.length) {
                    sendResponse({ ok: false, error: 'No panoramas in the route.' });
                    return;
                }
                engine.startBatch(message.job, post).catch(() => {});
                sendResponse({ ok: true });
                return;
            }
            case 'pr:cancel':
                engine.cancel(message.jobId);
                sendResponse({ ok: true });
                return;
            case 'pr:revoke':
                engine.revoke(message.url);
                sendResponse({ ok: true });
                return;
            default:
                return;
        }
    });
})();
