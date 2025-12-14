import { window } from "vscode";

/* Legacy uImage header parsing for mkimage -T script (boot.scr). */
export type UImageHeader = {
  magic: number;
  hcrc: number;
  timestamp: number;
  size: number;
  loadAddr: number;
  entryPoint: number;
  dcrc: number;
  os: number;
  arch: number;
  type: number;
  comp: number;
  name: string;
};

export type ParsedUImage = {
  header: UImageHeader;
  dataArea: Uint8Array;     // bytes covered by header.size/header.dcrc (starts at 64)
  script: Uint8Array;       // actual script text bytes
  lenPrefixed: boolean;     // true if [len][0] wrapper present
};

const UIMAGE_MAGIC = 0x27051956;
const HEADER_SIZE = 64;

// Common mkimage values (not exhaustive):
// type=6 is "script" in legacy uImage enums
const TYPE_SCRIPT = 6;
const COMP_NONE = 0;

function readU32BE(buf: Uint8Array, off: number): number {
  return (
    (buf[off] << 24) |
    (buf[off + 1] << 16) |
    (buf[off + 2] << 8) |
    buf[off + 3]
  ) >>> 0;
}

function writeU32BE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function decodeName(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.length;
  return new TextDecoder("ascii").decode(bytes.slice(0, end)).trim();
}

function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(32);
  const raw = new TextEncoder().encode(name);
  out.set(raw.slice(0, 32));
  return out;
}

/* CRC32 (IEEE 802.3), used by uImage for both data CRC and header CRC. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, seed = 0xffffffff): number {
  let c = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function parseLegacyUImage(buf: Uint8Array): { header: UImageHeader; script: string } {
  if (buf.length < HEADER_SIZE) {
    throw new Error("File too small to be a legacy uImage.");
  }

  const magic = readU32BE(buf, 0);
  if (magic !== UIMAGE_MAGIC) {
    throw new Error("Not a legacy uImage (bad magic).");
  }

  const header: UImageHeader = {
    magic,
    hcrc: readU32BE(buf, 4),
    timestamp: readU32BE(buf, 8),
    size: readU32BE(buf, 12),
    loadAddr: readU32BE(buf, 16),
    entryPoint: readU32BE(buf, 20),
    dcrc: readU32BE(buf, 24),
    os: buf[28],
    arch: buf[29],
    type: buf[30],
    comp: buf[31],
    name: decodeName(buf.slice(32, 64))
  };

  const payloadStart = HEADER_SIZE;
  const payloadEnd = payloadStart + header.size;
  if (payloadEnd > buf.length) {
    throw new Error(`Declared payload size (${header.size}) exceeds file length.`);
  }

  const payload = buf.slice(payloadStart, payloadEnd);

  // Optional integrity check (don’t hard-fail on mismatch; warn upstream if needed).
  const calcDcrc = crc32(payload);
  // Header CRC is computed over header with hcrc field set to 0.
  const hdrCopy = buf.slice(0, HEADER_SIZE);
  writeU32BE(hdrCopy, 4, 0);
  const calcHcrc = crc32(hdrCopy);

  // Return data; caller can decide how strict to be.
  // We still expose parsed header even if CRC mismatches.
  if (calcDcrc !== header.dcrc || calcHcrc !== header.hcrc) {
    window.showWarningMessage(`boot.scr CRC mismatch`)
  }

  if (payload.length < 8) {
    throw new Error(`Payload size less than 8`);
  }

  const scriptBytes = payload.slice(8, payload.length);
  const script = new TextDecoder("utf-8").decode(scriptBytes);
  return { header, script };
}

export function buildLegacyScriptImage(args: {
  script: string;
  baseHeader?: Partial<UImageHeader>;
  defaultName: string;
  defaultLoadAddr: number;
  defaultEntryPoint: number;
}): Uint8Array {
  const scriptBytes = new TextEncoder().encode(args.script);
  const payload = new Uint8Array(8 + scriptBytes.length);
  writeU32BE(payload, 0, scriptBytes.length);
  writeU32BE(payload, 4, 0);
  payload.set(scriptBytes, 8);

  const headerBuf = new Uint8Array(HEADER_SIZE);
  writeU32BE(headerBuf, 0, UIMAGE_MAGIC);
  writeU32BE(headerBuf, 4, 0); // hcrc placeholder
  writeU32BE(headerBuf, 8, Math.floor(Date.now() / 1000));
  writeU32BE(headerBuf, 12, payload.length);

  const loadAddr = args.baseHeader?.loadAddr ?? args.defaultLoadAddr;
  const entryPoint = args.baseHeader?.entryPoint ?? args.defaultEntryPoint;
  writeU32BE(headerBuf, 16, loadAddr);
  writeU32BE(headerBuf, 20, entryPoint);

  const dcrc = crc32(payload);
  writeU32BE(headerBuf, 24, dcrc);

  headerBuf[28] = (args.baseHeader?.os ?? 5) & 0xff;     // default "Linux" (common mkimage usage)
  headerBuf[29] = (args.baseHeader?.arch ?? 2) & 0xff;   // default "ARM" (commonly 2), overridden if header exists
  headerBuf[30] = (args.baseHeader?.type ?? TYPE_SCRIPT) & 0xff;
  headerBuf[31] = (args.baseHeader?.comp ?? COMP_NONE) & 0xff;

  const name = args.baseHeader?.name ?? args.defaultName;
  headerBuf.set(encodeName(name), 32);

  // Now compute header CRC over header with hcrc=0
  const hcrc = crc32(headerBuf);
  writeU32BE(headerBuf, 4, hcrc);

  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out.set(headerBuf, 0);
  out.set(payload, HEADER_SIZE);
  return out;
}
