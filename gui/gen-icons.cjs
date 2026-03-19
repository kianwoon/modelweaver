const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function createValidPNG(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr_data = Buffer.alloc(13);
  ihdr_data.writeUInt32BE(size, 0);
  ihdr_data.writeUInt32BE(size, 4);
  ihdr_data[8] = 8;   // bit depth
  ihdr_data[9] = 6;   // RGBA
  ihdr_data[10] = 0;  // compression
  ihdr_data[11] = 0;  // filter
  ihdr_data[12] = 0;  // interlace
  const ihdr = makeChunk('IHDR', ihdr_data);

  const rawData = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    rawData[rowStart] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const pixStart = rowStart + 1 + x * 4;
      rawData[pixStart] = 26;     // R
      rawData[pixStart+1] = 26;   // G
      rawData[pixStart+2] = 46;   // B (#1a1a2e)
      rawData[pixStart+3] = 255;  // A
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

const dir = '/Users/kianwoonwong/Downloads/modelweaver/gui/icons';
fs.writeFileSync(dir + '/32x32.png', createValidPNG(32));
fs.writeFileSync(dir + '/128x128.png', createValidPNG(128));
fs.writeFileSync(dir + '/128x128@2x.png', createValidPNG(256));

const png128 = createValidPNG(128);

// ICO: PNG-based ICO wrapper
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
const icoEntry = Buffer.alloc(16);
icoEntry[0] = 0;
icoEntry[1] = 0;
icoEntry[2] = 0;
icoEntry[3] = 0;
icoEntry.writeUInt16LE(1, 4);
icoEntry.writeUInt16LE(32, 6);
icoEntry.writeUInt32LE(png128.length, 8);
icoEntry.writeUInt32LE(22, 12);
fs.writeFileSync(dir + '/icon.ico', Buffer.concat([icoHeader, icoEntry, png128]));

// ICNS: macOS icon format
const totalSize = 8 + 12 + png128.length;
const icnsHeader = Buffer.alloc(8);
icnsHeader.writeUInt32BE(0x69636E73, 0);
icnsHeader.writeUInt32BE(totalSize, 4);
const ic08Entry = Buffer.alloc(8);
ic08Entry.writeUInt32BE(0x69633038, 0);
ic08Entry.writeUInt32BE(png128.length, 4);
fs.writeFileSync(dir + '/icon.icns', Buffer.concat([icnsHeader, ic08Entry, png128]));

console.log('Valid RGBA icons created');
