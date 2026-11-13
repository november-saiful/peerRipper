import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 as crc32Value } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');

const sharedFiles = [
    'api.js',
    'background-core.js',
    'content.js',
    'engine.js',
    'popup.html',
    'popup.js',
    'stitcher.js',
];

const chromiumFiles = [...sharedFiles, 'background.js', 'bridge-chromium.js', 'offscreen.html', 'offscreen.js'];

const targets = [
    {
        name: 'chromium',
        patch: 'manifest.chromium.json',
        files: chromiumFiles,
        archive: 'peerripper-chromium.zip',
    },
    {
        name: 'edge',
        patch: 'manifest.chromium.json',
        files: chromiumFiles,
        archive: 'peerripper-edge.zip',
    },
    {
        name: 'opera',
        patch: 'manifest.chromium.json',
        files: chromiumFiles,
        archive: 'peerripper-opera.zip',
    },
    {
        name: 'firefox',
        patch: 'manifest.firefox.json',
        files: [...sharedFiles, 'bridge-firefox.js'],
        archive: 'peerripper-firefox.zip',
    },
];

function readJson(file) {
    return JSON.parse(readFileSync(path.join(extensionDir, file), 'utf8'));
}

function copyFile(name, destination) {
    const source = path.join(extensionDir, name);
    if (!existsSync(source)) throw new Error(`Missing extension file: ${name}`);
    const target = path.join(destination, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
}

function copyDirectory(name, destination) {
    const source = path.join(extensionDir, name);
    for (const entry of readdirSync(source)) {
        if (statSync(path.join(source, entry)).isDirectory()) copyDirectory(`${name}/${entry}`, destination);
        else copyFile(`${name}/${entry}`, destination);
    }
}

function dosTimestamp(date) {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

function collect(directory, prefix = '') {
    const entries = [];
    for (const name of readdirSync(directory)) {
        const full = path.join(directory, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        if (statSync(full).isDirectory()) entries.push(...collect(full, relative));
        else entries.push({ name: relative, data: readFileSync(full), mtime: statSync(full).mtime });
    }
    return entries;
}

// Minimal store-only ZIP writer so packaging needs no dependencies.
function zip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const crc = crc32Value(entry.data) >>> 0;
        const stamp = dosTimestamp(entry.mtime);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(entry.data.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(0, 10);
        header.writeUInt16LE(stamp.time, 12);
        header.writeUInt16LE(stamp.date, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(entry.data.length, 20);
        header.writeUInt32LE(entry.data.length, 24);
        header.writeUInt16LE(name.length, 28);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(offset, 42);

        chunks.push(local, name, entry.data);
        central.push(header, name);
        offset += local.length + name.length + entry.data.length;
    }

    const centralSize = central.reduce((total, buffer) => total + buffer.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...chunks, ...central, end]);
}

rmSync(distDir, { recursive: true, force: true });
const base = readJson('manifest.base.json');

for (const target of targets) {
    const patch = readJson(target.patch);
    const manifest = { ...base, ...patch };
    const destination = path.join(distDir, target.name);

    mkdirSync(destination, { recursive: true });
    for (const file of target.files) copyFile(file, destination);
    copyDirectory('icons', destination);

    writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(distDir, target.archive), zip(collect(destination)));
    console.log(`${target.name}: ${target.files.length} files + icons → dist/${target.name} (${target.archive})`);
}

console.log('Version', base.version);
