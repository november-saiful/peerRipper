// Firefox exposes the promise-based `browser` namespace; Chromium exposes `chrome`,
// whose MV3 APIs also return promises.
globalThis.PeerRipperApi = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
