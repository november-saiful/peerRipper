import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const target = process.env.PEERRIPPER_TARGET || 'chromium';
const extPath = path.join(root, 'dist', target);
const work = path.join(root, 'test', '.tmp');
const profile = path.join(work, 'profile');
const downloadsDir = path.join(work, 'downloads');

const goodPano = 'jGaYvr31o-KsarHZtXbc5w';
const badPano = 'CIHM0ogKEICAgID82oiv6gE';
const mapsUrl = (panoid) =>
    `https://www.google.com/maps/@23.8103,90.4125,3a,75y,270h,90t/data=!3m6!1e1!3m4!1s${panoid}!2e0!7i10240!8i5120`;

if (!existsSync(extPath)) throw new Error(`Build the extension first: node tools/build.mjs`);

rmSync(work, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
mkdirSync(downloadsDir, { recursive: true });
writeFileSync(
    path.join(profile, 'Preferences'),
    JSON.stringify({
        download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
        savefile: { default_directory: downloadsDir },
    }),
);

const executablePath = existsSync(chromium.executablePath())
    ? chromium.executablePath()
    : 'C:/Users/Blackpearl/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const logs = [];
context.on('weberror', (error) => logs.push(`weberror: ${error.error().message}`));

try {
    await context.route('https://www.google.com/maps/**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body:
                '<!doctype html><html><head><meta charset="utf-8"><title>Street View</title></head>' +
                '<body style="margin:0;height:100vh;background:#202124;color:#eee;font-family:sans-serif">' +
                '<h1 style="padding:24px">Street View test page</h1></body></html>',
        }),
    );

    const page = await context.newPage();
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(mapsUrl(goodPano), { waitUntil: 'domcontentloaded' });
    await page.locator('#peerripper-root .pill').waitFor({ state: 'visible', timeout: 20000 });

    const sw =
        context.serviceWorkers().find((worker) => worker.url().includes('background.js')) ||
        (await context.waitForEvent('serviceworker', { timeout: 10000 }));
    const extensionId = new URL(sw.url()).host;
    // The browser's own download flow must be used: a CDP download path makes
    // Chromium ignore the extension's suggested filename.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    const tabId = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab.id;
    });
    const probe = () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'pr:probe' }), tabId);

    const popup = await context.newPage();
    popup.on('pageerror', (error) => logs.push(`popup error: ${error.message}`));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    async function popupText(selector) {
        return popup.evaluate((id) => document.getElementById(id).textContent, selector);
    }

    async function pollPopup(selector, predicate, timeout = 15000) {
        const deadline = Date.now() + timeout;
        let text = '';
        while (Date.now() < deadline) {
            text = await popupText(selector);
            if (predicate(text)) return text;
            await popup.waitForTimeout(200);
        }
        throw new Error(`${selector} stayed "${text}"`);
    }

    async function searchDownloads() {
        return sw.evaluate(async () => {
            const items = await chrome.downloads.search({});
            return items.map((item) => ({
                state: item.state,
                exists: item.exists,
                filename: item.filename,
            }));
        });
    }

    async function waitForDownload() {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const items = await searchDownloads();
            const complete = items.filter((item) => item.state === 'complete' && item.exists);
            if (complete.length) return complete;
            await popup.waitForTimeout(300);
        }
        throw new Error('No completed download appeared.');
    }

    await page.bringToFront();
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await pollPopup('status', (text) => text.includes('Panorama'));
    console.log('popup:', await popupText('status'), '/', await popupText('detail'));

    // --- single panorama at half resolution
    await popup.locator('#zoom').selectOption('4');
    await popup.locator('#go').click();
    await page.bringToFront();

    const note = page.locator('#peerripper-root .card .note');
    await page.waitForFunction(
        () => {
            const host = document.querySelector('#peerripper-root');
            const card = host && host.shadowRoot && host.shadowRoot.querySelector('.card');
            return card && !card.hidden && card.querySelector('.note').textContent.startsWith('Saved');
        },
        null,
        { timeout: 180000, polling: 250 },
    );
    console.log('card:', await note.textContent());

    await popup.bringToFront();
    await pollPopup('status', (text) => text.includes('Saved'));
    console.log('single result:', await popupText('status'), '/', await popupText('detail'));

    let complete = await waitForDownload();
    if (complete.length !== 1) throw new Error(`Expected 1 download, got ${complete.length}`);
    const singleName = `streetview_${goodPano}_6656x3328.jpg`;
    if (path.basename(complete[0].filename) !== singleName) {
        throw new Error(`Wrong single filename: ${path.basename(complete[0].filename)}`);
    }
    let bytes = readFileSync(complete[0].filename);
    let size = jpegSize(bytes);
    console.log('single file:', path.basename(complete[0].filename), bytes.length, size);
    if (!size || size.width !== 6656 || size.height !== 3328) {
        throw new Error(`Unexpected single panorama size: ${JSON.stringify(size)}`);
    }
    assertJpeg(bytes);

    // --- recorded route with one unavailable photo sphere
    await popup.locator('#record').click();
    await page.waitForTimeout(500);

    await page.evaluate(
        (panoid) => {
            const parts = location.href.split('!1s');
            history.pushState({}, '', `${parts[0]}!1s${panoid}!2e0!7i10240!8i5120`);
        },
        badPano,
    );
    await page.waitForTimeout(2000);
    console.log('route:', JSON.stringify(await probe()));

    await popup.bringToFront();
    const batchLabel = await pollPopup('batch', (text) => text.includes('(2)'));
    console.log('batch button:', batchLabel);
    await popup.locator('#zoom').selectOption('3');
    await popup.locator('#batch').click();

    await pollPopup('status', (text) => text.includes('Saved') || text.includes('failed'), 180000);
    console.log('batch result:', await popupText('status'), '/', await popupText('detail'));
    if (!/1 of 2/.test(await popupText('detail'))) {
        throw new Error(`Expected 1 of 2 saved, got "${await popupText('detail')}"`);
    }

    const pageNote = await page.evaluate(() => {
        const host = document.querySelector('#peerripper-root');
        return host.shadowRoot.querySelector('.note').textContent;
    });
    console.log('card:', pageNote);
    if (!/Saved 1 of 2/.test(pageNote)) throw new Error(`Unexpected card note: ${pageNote}`);

    complete = await waitForDownload();
    if (complete.length !== 2) throw new Error(`Expected 2 downloads, got ${complete.length}`);
    const batchFile = complete.find((item) => item.filename.includes('peerRipper'));
    if (!batchFile) throw new Error('Batch file was not saved into the peerRipper folder.');
    const batchName = `001_${goodPano}_3328x1664.jpg`;
    if (path.basename(batchFile.filename) !== batchName) {
        throw new Error(`Wrong batch filename: ${path.basename(batchFile.filename)}`);
    }
    bytes = readFileSync(batchFile.filename);
    size = jpegSize(bytes);
    console.log('batch file:', path.basename(batchFile.filename), bytes.length, size);
    if (!size || size.width !== 3328 || size.height !== 1664) {
        throw new Error(`Unexpected batch panorama size: ${JSON.stringify(size)}`);
    }
    assertJpeg(bytes);

    cleanupDownloads(complete);
    console.log('PASS');
    if (logs.length) console.log(logs.join('\n'));
} finally {
    await context.close();
}

function jpegSize(bytes) {
    let i = 2;
    while (i < bytes.length - 1) {
        if (bytes[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = bytes[i + 1];
        i += 2;
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 2 > bytes.length) break;
        const length = bytes.readUInt16BE(i);
        if (marker >= 0xc0 && marker <= 0xc3) {
            return { height: bytes.readUInt16BE(i + 3), width: bytes.readUInt16BE(i + 5) };
        }
        i += length;
    }
    return null;
}

function assertJpeg(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Missing JPEG SOI marker.');
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        throw new Error('Missing JPEG EOI marker.');
    }
}

function cleanupDownloads(items) {
    for (const item of items) {
        try {
            rmSync(item.filename, { force: true });
        } catch {
            // The file was already moved or removed.
        }
        if (path.basename(path.dirname(item.filename)) === 'peerRipper') {
            try {
                rmdirSync(path.dirname(item.filename));
            } catch {
                // The folder still has other panoramas in it.
            }
        }
    }
}
