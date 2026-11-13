// DCT-domain JPEG stitcher.
// Baseline 4:2:0 tiles are parsed to quantized coefficients and re-encoded into one
// scan, so the image is never decoded to pixels or re-compressed. Where a tile uses a
// different quantization table than the panorama-wide (element-wise min) table, its
// coefficients are re-quantized onto the finer table.

const TILE_SIZE = 512;
const BLOCKS_PER_TILE = TILE_SIZE / 8;
const CHROMA_BLOCKS_PER_TILE = TILE_SIZE / 16;
const MCUS_PER_TILE = TILE_SIZE / 16;

class ByteWriter {
    constructor() {
        this.buf = new Uint8Array(1 << 16);
        this.len = 0;
    }

    ensure(extra) {
        const needed = this.len + extra;
        if (needed <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < needed) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }

    byte(value) {
        this.ensure(1);
        this.buf[this.len++] = value & 0xff;
    }

    write(bytes) {
        this.ensure(bytes.length);
        this.buf.set(bytes, this.len);
        this.len += bytes.length;
    }

    result() {
        return this.buf.slice(0, this.len);
    }
}

class BitReader {
    constructor() {
        this.data = null;
        this.pos = 0;
        this.buffer = 0;
        this.bits = 0;
    }

    reset(data) {
        this.data = data;
        this.pos = 0;
        this.buffer = 0;
        this.bits = 0;
    }

    getBit() {
        if (this.bits === 0) {
            if (this.pos >= this.data.length) return -1;
            this.buffer = this.data[this.pos++];
            this.bits = 8;
        }
        this.bits -= 1;
        return (this.buffer >> this.bits) & 1;
    }

    getBits(count) {
        let result = 0;
        for (let i = 0; i < count; i++) {
            const bit = this.getBit();
            if (bit < 0) return -1;
            result = (result << 1) | bit;
        }
        return result;
    }
}

class BitWriter {
    constructor(out) {
        this.out = out;
        this.accumulator = 0;
        this.pending = 0;
    }

    put(value, count) {
        if (count <= 0) return;
        this.accumulator = (this.accumulator << count) | (value & ((1 << count) - 1));
        this.pending += count;
        while (this.pending >= 8) {
            this.pending -= 8;
            const byte = (this.accumulator >> this.pending) & 0xff;
            this.out.byte(byte);
            if (byte === 0xff) this.out.byte(0x00);
        }
        this.accumulator = this.pending === 0 ? 0 : this.accumulator & ((1 << this.pending) - 1);
    }

    finish() {
        if (this.pending > 0) {
            const pad = 8 - this.pending;
            const byte = ((this.accumulator << pad) | ((1 << pad) - 1)) & 0xff;
            this.out.byte(byte);
            if (byte === 0xff) this.out.byte(0x00);
            this.accumulator = 0;
            this.pending = 0;
        }
    }
}

function makeHuffTable() {
    return {
        counts: new Uint8Array(17),
        values: new Uint8Array(256),
        firstCode: new Uint16Array(17),
        firstIndex: new Uint16Array(17),
        valid: false,
    };
}

function buildHuffTable(table) {
    let code = 0;
    let next = 0;
    for (let len = 1; len <= 16; len++) {
        table.firstCode[len] = code;
        table.firstIndex[len] = next;
        next += table.counts[len];
        code = (code + table.counts[len]) << 1;
    }
    table.valid = next > 0;
}

function decodeHuff(table, reader) {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
        const bit = reader.getBit();
        if (bit < 0) return -1;
        code = (code << 1) | bit;
        const count = table.counts[len];
        if (count) {
            const index = code - table.firstCode[len];
            if (index >= 0 && index < count) return table.values[table.firstIndex[len] + index];
        }
    }
    return -1;
}

function makeHuffCodes() {
    return { code: new Uint16Array(256), length: new Uint8Array(256) };
}

function buildHuffCodes(dst, counts, values, valueCount) {
    let next = 0;
    let current = 0;
    for (let len = 1; len <= 16; len++) {
        for (let i = 0; i < counts[len - 1]; i++) {
            if (next >= valueCount) return false;
            const symbol = values[next++];
            dst.code[symbol] = current++;
            dst.length[symbol] = len;
        }
        current <<= 1;
    }
    return next === valueCount;
}

function emitHuff(codes, writer, symbol) {
    if (symbol < 0 || symbol > 255 || codes.length[symbol] === 0) return false;
    writer.put(codes.code[symbol], codes.length[symbol]);
    return true;
}

// Standard Huffman tables (ITU T.81 Annex K).
const DC_LUM_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHR_COUNTS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHR_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VALUES = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];
const AC_CHR_COUNTS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHR_VALUES = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];

function makeTileInfo() {
    return {
        qY: new Uint16Array(64),
        qC: new Uint16Array(64),
        dc: [makeHuffTable(), makeHuffTable(), makeHuffTable(), makeHuffTable()],
        ac: [makeHuffTable(), makeHuffTable(), makeHuffTable(), makeHuffTable()],
        dcSel: [0, 1, 1],
        acSel: [0, 1, 1],
        restartInterval: 0,
        scanStart: 0,
        scanEnd: 0,
    };
}

function parseTile(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG stream');

    const info = makeTileInfo();
    const qtables = [];
    for (let i = 0; i < 4; i++) qtables.push(new Uint16Array(64));
    const hasTable = [false, false, false, false];
    const componentTable = [0, 0, 0];
    let haveFrame = false;
    let haveScan = false;

    let pos = 2;
    while (pos + 1 < bytes.length) {
        if (bytes[pos] !== 0xff) throw new Error('invalid marker alignment');
        while (pos < bytes.length && bytes[pos] === 0xff) pos++;
        if (pos >= bytes.length) break;
        const marker = bytes[pos++];

        if (marker === 0xd9) break;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (pos + 2 > bytes.length) throw new Error('truncated JPEG segment');
        const length = (bytes[pos] << 8) | bytes[pos + 1];
        if (length < 2 || pos + length > bytes.length) throw new Error('truncated JPEG segment');
        const segment = pos + 2;
        const segmentEnd = pos + length;

        switch (marker) {
            case 0xdb: {
                let p = segment;
                while (p < segmentEnd) {
                    const entry = bytes[p++];
                    const precision = entry >> 4;
                    const id = entry & 15;
                    if (precision !== 0 || id > 3 || p + 64 > segmentEnd) {
                        throw new Error('unsupported quantization table');
                    }
                    for (let i = 0; i < 64; i++) qtables[id][i] = bytes[p++];
                    hasTable[id] = true;
                }
                break;
            }
            case 0xc0: {
                if (length < 17 || segment + 17 > bytes.length) throw new Error('invalid frame header');
                const precision = bytes[segment];
                const height = (bytes[segment + 1] << 8) | bytes[segment + 2];
                const width = (bytes[segment + 3] << 8) | bytes[segment + 4];
                const components = bytes[segment + 5];
                if (precision !== 8 || components !== 3 || width !== TILE_SIZE || height !== TILE_SIZE) {
                    throw new Error('unsupported frame layout');
                }
                const expected = [0x22, 0x11, 0x11];
                for (let i = 0; i < 3; i++) {
                    const id = bytes[segment + 6 + i * 3];
                    const sampling = bytes[segment + 7 + i * 3];
                    componentTable[i] = bytes[segment + 8 + i * 3];
                    if (id !== i + 1 || sampling !== expected[i] || componentTable[i] > 3) {
                        throw new Error('unsupported chroma subsampling');
                    }
                }
                haveFrame = true;
                break;
            }
            case 0xc1:
            case 0xc2:
            case 0xc3:
            case 0xc5:
            case 0xc6:
            case 0xc7:
            case 0xc9:
            case 0xca:
            case 0xcb:
            case 0xcd:
            case 0xce:
            case 0xcf:
                throw new Error('unsupported JPEG coding process');
            case 0xc4: {
                let p = segment;
                while (p < segmentEnd) {
                    const entry = bytes[p++];
                    const tableClass = entry >> 4;
                    const id = entry & 15;
                    if (tableClass > 1 || id > 3 || p + 16 > segmentEnd) throw new Error('invalid Huffman table');
                    const table = tableClass ? info.ac[id] : info.dc[id];
                    let total = 0;
                    for (let i = 1; i <= 16; i++) {
                        table.counts[i] = bytes[p++];
                        total += table.counts[i];
                    }
                    if (total > 256 || p + total > segmentEnd) throw new Error('invalid Huffman table');
                    for (let i = 0; i < total; i++) table.values[i] = bytes[p++];
                    buildHuffTable(table);
                }
                break;
            }
            case 0xdd: {
                if (length >= 4) info.restartInterval = (bytes[segment] << 8) | bytes[segment + 1];
                break;
            }
            case 0xda: {
                if (length < 8 || segment + 1 > segmentEnd) throw new Error('invalid scan header');
                const components = bytes[segment];
                if (components !== 3 || segment + 1 + components * 2 > segmentEnd) {
                    throw new Error('invalid scan header');
                }
                for (let i = 0; i < 3; i++) {
                    const id = bytes[segment + 1 + i * 2];
                    const selectors = bytes[segment + 2 + i * 2];
                    if (id !== i + 1) throw new Error('invalid scan component');
                    info.dcSel[i] = selectors >> 4;
                    info.acSel[i] = selectors & 15;
                }
                info.scanStart = segmentEnd;

                let scan = segmentEnd;
                let found = false;
                while (scan + 1 < bytes.length) {
                    if (bytes[scan] !== 0xff) {
                        scan++;
                        continue;
                    }
                    const next = bytes[scan + 1];
                    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
                        scan += 2;
                        continue;
                    }
                    if (next === 0xff) {
                        scan++;
                        continue;
                    }
                    if (next === 0xd9) {
                        info.scanEnd = scan;
                        found = true;
                        break;
                    }
                    throw new Error('unexpected marker inside the scan');
                }
                if (!found) throw new Error('scan is not terminated');
                haveScan = true;
                break;
            }
            default:
                break;
        }

        if (haveScan) break;
        pos = segmentEnd;
    }

    if (!haveFrame || !haveScan) throw new Error('missing frame or scan');
    for (let i = 0; i < 3; i++) {
        if (!hasTable[componentTable[i]]) throw new Error('missing quantization table');
    }
    if (componentTable[1] !== componentTable[2]) throw new Error('chroma components use different quantization');
    info.qY.set(qtables[componentTable[0]]);
    info.qC.set(qtables[componentTable[1]]);
    for (let i = 0; i < 3; i++) {
        if (!info.dc[info.dcSel[i]].valid || !info.ac[info.acSel[i]].valid) {
            throw new Error('missing Huffman table');
        }
    }
    return info;
}

function splitScan(bytes, info) {
    const segments = [];
    let current = new Uint8Array(info.scanEnd - info.scanStart);
    let used = 0;
    for (let i = info.scanStart; i < info.scanEnd; i++) {
        const byte = bytes[i];
        if (byte !== 0xff) {
            current[used++] = byte;
            continue;
        }
        if (i + 1 >= info.scanEnd) {
            current[used++] = 0xff;
            break;
        }
        const next = bytes[++i];
        if (next === 0x00) {
            current[used++] = 0xff;
            continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
            segments.push(current.subarray(0, used));
            current = new Uint8Array(info.scanEnd - info.scanStart);
            used = 0;
            continue;
        }
        throw new Error('unexpected marker inside the scan');
    }
    segments.push(current.subarray(0, used));
    if (info.restartInterval === 0 && segments.length !== 1) throw new Error('unexpected restart markers');
    return segments;
}

function requantize(value, tileQ, commonQ) {
    if (tileQ === commonQ) return value;
    const scaled = value * tileQ;
    const divisor = commonQ > 0 ? commonQ : 1;
    const half = Math.floor(divisor / 2);
    const result = scaled >= 0 ? Math.trunc((scaled + half) / divisor) : -Math.trunc((-scaled + half) / divisor);
    return Math.max(-32768, Math.min(32767, result));
}

function extend(value, size) {
    if (size === 0) return 0;
    const threshold = 1 << (size - 1);
    return value < threshold ? value - ((1 << size) - 1) : value;
}

function decodeBlock(reader, dc, ac, tileQ, commonQ, state, out, offset) {
    out.fill(0, offset, offset + 64);
    const dcSize = decodeHuff(dc, reader);
    if (dcSize < 0 || dcSize > 11) return false;
    let difference = 0;
    if (dcSize > 0) {
        const value = reader.getBits(dcSize);
        if (value < 0) return false;
        difference = extend(value, dcSize);
    }
    state.predictor += difference;
    out[offset] = requantize(state.predictor, tileQ[0], commonQ[0]);

    let k = 1;
    while (k < 64) {
        const symbol = decodeHuff(ac, reader);
        if (symbol < 0) return false;
        const run = symbol >> 4;
        const size = symbol & 15;
        if (size === 0) {
            if (run === 15) {
                k += 16;
                continue;
            }
            break;
        }
        k += run;
        if (k > 63) return false;
        const value = reader.getBits(size);
        if (value < 0) return false;
        out[offset + k] = requantize(extend(value, size), tileQ[k], commonQ[k]);
        k++;
    }
    return true;
}

function decodeTile(info, bytes, commonY, commonC, planes) {
    const segments = splitScan(bytes, info);
    const y = planes.y;
    const cb = planes.cb;
    const cr = planes.cr;

    let segmentIndex = 0;
    const reader = new BitReader();
    reader.reset(segments[0]);
    const stateY = { predictor: 0 };
    const stateCb = { predictor: 0 };
    const stateCr = { predictor: 0 };

    const offsetsX = [0, 1, 0, 1];
    const offsetsY = [0, 0, 1, 1];
    const mcuCount = MCUS_PER_TILE * MCUS_PER_TILE;
    for (let mcu = 0; mcu < mcuCount; mcu++) {
        if (info.restartInterval > 0 && mcu > 0 && mcu % info.restartInterval === 0) {
            segmentIndex++;
            if (segmentIndex >= segments.length) return false;
            reader.reset(segments[segmentIndex]);
            stateY.predictor = 0;
            stateCb.predictor = 0;
            stateCr.predictor = 0;
        }
        const mx = mcu % MCUS_PER_TILE;
        const my = (mcu / MCUS_PER_TILE) | 0;
        for (let block = 0; block < 4; block++) {
            const bx = mx * 2 + offsetsX[block];
            const by = my * 2 + offsetsY[block];
            if (!decodeBlock(reader, info.dc[info.dcSel[0]], info.ac[info.acSel[0]], info.qY, commonY, stateY,
                             y.coefficients, (by * y.blocksWide + bx) * 64)) {
                return false;
            }
        }
        if (!decodeBlock(reader, info.dc[info.dcSel[1]], info.ac[info.acSel[1]], info.qC, commonC, stateCb,
                         cb.coefficients, (my * cb.blocksWide + mx) * 64)) {
            return false;
        }
        if (!decodeBlock(reader, info.dc[info.dcSel[2]], info.ac[info.acSel[2]], info.qC, commonC, stateCr,
                         cr.coefficients, (my * cr.blocksWide + mx) * 64)) {
            return false;
        }
    }
    return true;
}

function makePlane() {
    return {
        blocksWide: BLOCKS_PER_TILE,
        coefficients: new Int16Array(BLOCKS_PER_TILE * BLOCKS_PER_TILE * 64),
    };
}

function makeChromaPlane() {
    return {
        blocksWide: CHROMA_BLOCKS_PER_TILE,
        coefficients: new Int16Array(CHROMA_BLOCKS_PER_TILE * CHROMA_BLOCKS_PER_TILE * 64),
    };
}

function category(value) {
    let magnitude = value < 0 ? -value : value;
    let size = 0;
    while (magnitude) {
        size++;
        magnitude >>>= 1;
    }
    return size;
}

class Encoder {
    constructor(writer) {
        this.writer = writer;
        this.dcY = makeHuffCodes();
        this.acY = makeHuffCodes();
        this.dcC = makeHuffCodes();
        this.acC = makeHuffCodes();
        this.stateY = { predictor: 0 };
        this.stateCb = { predictor: 0 };
        this.stateCr = { predictor: 0 };
    }

    init() {
        return (
            buildHuffCodes(this.dcY, DC_LUM_COUNTS, DC_LUM_VALUES, 12) &&
            buildHuffCodes(this.acY, AC_LUM_COUNTS, AC_LUM_VALUES, 162) &&
            buildHuffCodes(this.dcC, DC_CHR_COUNTS, DC_CHR_VALUES, 12) &&
            buildHuffCodes(this.acC, AC_CHR_COUNTS, AC_CHR_VALUES, 162)
        );
    }

    putValue(value, size) {
        const bits = value < 0 ? value + (1 << size) - 1 : value;
        this.writer.put(bits, size);
    }

    encodeBlock(coefficients, offset, dc, ac, state) {
        const difference = coefficients[offset] - state.predictor;
        state.predictor = coefficients[offset];
        let size = category(difference);
        if (size > 11) return false;
        if (!emitHuff(dc, this.writer, size)) return false;
        if (size > 0) this.putValue(difference, size);

        let run = 0;
        for (let k = 1; k < 64; k++) {
            const value = coefficients[offset + k];
            if (value === 0) {
                run++;
                continue;
            }
            while (run > 15) {
                if (!emitHuff(ac, this.writer, 0xf0)) return false;
                run -= 16;
            }
            size = category(value);
            if (size > 10) return false;
            if (!emitHuff(ac, this.writer, (run << 4) | size)) return false;
            this.putValue(value, size);
            run = 0;
        }
        if (run > 0 && !emitHuff(ac, this.writer, 0x00)) return false;
        return true;
    }
}

function writeDht(out, selector, counts, values, valueCount) {
    const length = 2 + 1 + 16 + valueCount;
    out.byte(0xff);
    out.byte(0xc4);
    out.byte(length >> 8);
    out.byte(length & 0xff);
    out.byte(selector);
    for (let i = 0; i < 16; i++) out.byte(counts[i]);
    for (let i = 0; i < valueCount; i++) out.byte(values[i]);
}

function writeHeader(out, width, height, qY, qC) {
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
                  0x00, 0x00];
    out.byte(0xff);
    out.byte(0xd8);
    out.write(app0);

    const dqtLength = 2 + 2 * (1 + 64);
    out.byte(0xff);
    out.byte(0xdb);
    out.byte(dqtLength >> 8);
    out.byte(dqtLength & 0xff);
    out.byte(0x00);
    for (let i = 0; i < 64; i++) out.byte(qY[i] > 255 ? 255 : qY[i]);
    out.byte(0x01);
    for (let i = 0; i < 64; i++) out.byte(qC[i] > 255 ? 255 : qC[i]);

    out.byte(0xff);
    out.byte(0xc0);
    out.byte(0x00);
    out.byte(0x11);
    out.byte(0x08);
    out.byte(height >> 8);
    out.byte(height & 0xff);
    out.byte(width >> 8);
    out.byte(width & 0xff);
    out.byte(0x03);
    out.write(new Uint8Array([1, 0x22, 0x00, 2, 0x11, 0x01, 3, 0x11, 0x01]));

    writeDht(out, 0x00, DC_LUM_COUNTS, DC_LUM_VALUES, 12);
    writeDht(out, 0x10, AC_LUM_COUNTS, AC_LUM_VALUES, 162);
    writeDht(out, 0x01, DC_CHR_COUNTS, DC_CHR_VALUES, 12);
    writeDht(out, 0x11, AC_CHR_COUNTS, AC_CHR_VALUES, 162);

    out.write(new Uint8Array([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f,
                              0x00]));
}

/**
 * Stitches baseline 4:2:0 512x512 JPEG tiles into one JPEG at outWidth x outHeight.
 * @param {Uint8Array[]} tiles row-major tile bytes
 * @param {number} cols
 * @param {number} rows
 * @param {number} outWidth must be a multiple of 16 and <= cols * 512
 * @param {number} outHeight must be a multiple of 16 and <= rows * 512
 * @returns {Uint8Array}
 */
function stitchJpegTiles(tiles, cols, rows, outWidth, outHeight) {
    if (cols <= 0 || rows <= 0 || tiles.length !== cols * rows) throw new Error('tile grid mismatch');
    if (outWidth <= 0 || outHeight <= 0 || outWidth % 16 !== 0 || outHeight % 16 !== 0) {
        throw new Error('output is not MCU aligned');
    }
    if (outWidth > cols * TILE_SIZE || outHeight > rows * TILE_SIZE) throw new Error('output exceeds the tile grid');

    const infos = new Array(tiles.length);
    for (let i = 0; i < tiles.length; i++) {
        try {
            infos[i] = parseTile(tiles[i]);
        } catch (error) {
            const x = i % cols;
            const y = (i / cols) | 0;
            throw new Error(`tile ${x},${y}: ${error.message}`);
        }
    }

    const commonY = new Uint16Array(64).fill(0xffff);
    const commonC = new Uint16Array(64).fill(0xffff);
    for (const info of infos) {
        for (let i = 0; i < 64; i++) {
            if (info.qY[i] < commonY[i]) commonY[i] = info.qY[i];
            if (info.qC[i] < commonC[i]) commonC[i] = info.qC[i];
        }
    }

    const out = new ByteWriter();
    writeHeader(out, outWidth, outHeight, commonY, commonC);

    const bits = new BitWriter(out);
    const encoder = new Encoder(bits);
    if (!encoder.init()) throw new Error('could not build the Huffman encoder');

    const mcusWide = outWidth / 16;
    const mcusHigh = outHeight / 16;
    const usedCols = Math.min(cols, Math.ceil(mcusWide / MCUS_PER_TILE));

    const planesY = [];
    const planesCb = [];
    const planesCr = [];
    for (let i = 0; i < usedCols; i++) {
        planesY.push(makePlane());
        planesCb.push(makeChromaPlane());
        planesCr.push(makeChromaPlane());
    }
    const planes = planesY.map((_, i) => ({ y: planesY[i], cb: planesCb[i], cr: planesCr[i] }));

    for (let ty = 0; ty < rows; ty++) {
        if (ty * MCUS_PER_TILE >= mcusHigh) break;
        const mcuRows = Math.min(MCUS_PER_TILE, mcusHigh - ty * MCUS_PER_TILE);

        for (let tx = 0; tx < usedCols; tx++) {
            const index = ty * cols + tx;
            if (!decodeTile(infos[index], tiles[index], commonY, commonC, planes[tx])) {
                throw new Error(`could not decode tile ${tx},${ty}`);
            }
        }

        for (let localRow = 0; localRow < mcuRows; localRow++) {
            for (let tx = 0; tx < usedCols; tx++) {
                const mcuCols = Math.min(MCUS_PER_TILE, mcusWide - tx * MCUS_PER_TILE);
                const y = planesY[tx].coefficients;
                const cb = planesCb[tx].coefficients;
                const cr = planesCr[tx].coefficients;
                for (let localCol = 0; localCol < mcuCols; localCol++) {
                    const ok =
                        encoder.encodeBlock(y, (localRow * 2 * BLOCKS_PER_TILE + localCol * 2) * 64, encoder.dcY,
                                            encoder.acY, encoder.stateY) &&
                        encoder.encodeBlock(y, (localRow * 2 * BLOCKS_PER_TILE + localCol * 2 + 1) * 64,
                                            encoder.dcY, encoder.acY, encoder.stateY) &&
                        encoder.encodeBlock(y, ((localRow * 2 + 1) * BLOCKS_PER_TILE + localCol * 2) * 64,
                                            encoder.dcY, encoder.acY, encoder.stateY) &&
                        encoder.encodeBlock(y, ((localRow * 2 + 1) * BLOCKS_PER_TILE + localCol * 2 + 1) * 64,
                                            encoder.dcY, encoder.acY, encoder.stateY) &&
                        encoder.encodeBlock(cb, (localRow * CHROMA_BLOCKS_PER_TILE + localCol) * 64, encoder.dcC,
                                            encoder.acC, encoder.stateCb) &&
                        encoder.encodeBlock(cr, (localRow * CHROMA_BLOCKS_PER_TILE + localCol) * 64, encoder.dcC,
                                            encoder.acC, encoder.stateCr);
                    if (!ok) throw new Error('could not encode the panorama');
                }
            }
        }
    }

    bits.finish();
    out.byte(0xff);
    out.byte(0xd9);
    return out.result();
}
