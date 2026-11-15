// Build script: bundles the TypeScript entries with esbuild (no minification, so store
// reviewers can read the output), copies static files, draws icons and writes manifest.json.
//
//   node build.mjs           dev build  (API http://localhost:8787, source maps, localhost host access)
//   node build.mjs --prod    prod build (API https://app.openkeyword.org)
//   node build.mjs --watch   dev build, rebuild on change
//   node build.mjs --prod --zip   prod build + release/openkeyword-<version>.zip for the Chrome Web Store
//
// Override the API base with env VITE_API_BASE, the website base with VITE_WEB_BASE and the
// landing site (home page and privacy policy) with VITE_SITE_BASE.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, deflateSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const prod = process.argv.includes("--prod");
const watch = process.argv.includes("--watch");
const zip = process.argv.includes("--zip");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const hosts = JSON.parse(readFileSync(join(root, "src/hosts.json"), "utf8"));

const API_BASE = (process.env.VITE_API_BASE || (prod ? "https://app.openkeyword.org" : "http://localhost:8787")).replace(/\/+$/, "");
const WEB_BASE = (process.env.VITE_WEB_BASE || (prod ? "https://app.openkeyword.org" : "http://localhost:5173")).replace(/\/+$/, "");
const SITE_BASE = (process.env.VITE_SITE_BASE || (prod ? "https://openkeyword.org" : "http://localhost:4321")).replace(/\/+$/, "");
// Public source code (GitHub). Set it only once the repository is public: it switches on the "open source"
// line in the pages and the open-source variant of the store summary.
const SOURCE_URL = (process.env.VITE_SOURCE_URL || "").replace(/\/+$/, "");
if (SOURCE_URL && !/^https:\/\//.test(SOURCE_URL)) throw new Error("VITE_SOURCE_URL must be an https:// URL");

// Store name and summary per language (Chrome's _locales). The store shows them in each language.
const STORE_LOCALES = JSON.parse(readFileSync(join(root, "store-listing/locales.json"), "utf8"));

/** Host match pattern for an origin. Match patterns cannot carry a port; they match all ports. */
function originPattern(base) {
  const u = new URL(base);
  return `${u.protocol}//${u.hostname}/*`;
}

function manifest() {
  const apiHosts = new Set([originPattern(API_BASE)]);
  if (!prod) {
    // Dev builds may point the API base at any local port from the Settings tab.
    apiHosts.add("http://localhost/*");
    apiHosts.add("http://127.0.0.1/*");
  }
  const icons = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };
  return {
    manifest_version: 3,
    name: prod ? "__MSG_extName__" : "OpenKeyword (dev)",
    short_name: "OpenKeyword",
    version: pkg.version,
    description: "__MSG_extDescription__",
    default_locale: "en",
    homepage_url: SITE_BASE,
    minimum_chrome_version: "116",
    icons,
    action: { default_title: "__MSG_actionTitle__", default_icon: icons, default_popup: "popup.html" },
    background: { service_worker: "background.js", type: "module" },
    permissions: ["storage", "alarms"],
    host_permissions: [...apiHosts],
    optional_host_permissions: hosts.search,
    incognito: "not_allowed",
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
}

// ---- icons (solid PNGs drawn in code, no binary assets in the repo) -----------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/**
 * The OpenKeyword mark (same as the website logo): a dark rounded square with a white
 * magnifier and an orange plus inside the lens. Drawn with 4x4 supersampling for smooth edges.
 */
function iconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const DARK = [35, 36, 39];
  const WHITE = [255, 255, 255];
  const ORANGE = [232, 100, 58];
  const r = 0.22; // corner radius, as a fraction
  const lens = { x: 0.44, y: 0.44, r: 0.22 };
  const stroke = size <= 16 ? 0.1 : 0.075;
  const distSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  /** Colour and coverage at one point (fractions of the icon). */
  function sample(fx, fy) {
    const cx = Math.min(fx, 1 - fx), cy = Math.min(fy, 1 - fy);
    const inside = cx >= r || cy >= r || (r - cx) ** 2 + (r - cy) ** 2 <= r * r;
    if (!inside) return null;
    const ring = Math.abs(Math.hypot(fx - lens.x, fy - lens.y) - lens.r) <= stroke / 2;
    const handle = distSeg(fx, fy, 0.6, 0.6, 0.78, 0.78) <= stroke * 0.62;
    if (ring || handle) return WHITE;
    const arm = 0.1, w = stroke / 2;
    const plus = (Math.abs(fy - lens.y) <= w && Math.abs(fx - lens.x) <= arm) || (Math.abs(fx - lens.x) <= w && Math.abs(fy - lens.y) <= arm);
    if (plus && size > 16) return ORANGE;
    return DARK;
  }
  const S = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = sample((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          if (!c) continue;
          R += c[0]; G += c[1]; B += c[2]; n++;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = n ? Math.round(R / n) : 0;
      raw[o + 1] = n ? Math.round(G / n) : 0;
      raw[o + 2] = n ? Math.round(B / n) : 0;
      raw[o + 3] = Math.round((n / (S * S)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- build --------------------------------------------------------------------------------

// Brand fonts, bundled so the extension pages load nothing from the network (SIL Open Font License).
const FONTS = [
  ...[400, 500, 600].flatMap((w) => [["space-grotesk", `space-grotesk-latin-${w}-normal.woff2`], ["space-grotesk", `space-grotesk-latin-ext-${w}-normal.woff2`]]),
  ...[400, 500].flatMap((w) => [["jetbrains-mono", `jetbrains-mono-latin-${w}-normal.woff2`], ["jetbrains-mono", `jetbrains-mono-latin-ext-${w}-normal.woff2`]]),
];

/** _locales/<code>/messages.json for every store language. Fails the build on Chrome's length limits. */
function writeLocales() {
  for (const [code, l] of Object.entries(STORE_LOCALES)) {
    const summary = SOURCE_URL ? l.summaryOpenSource : l.summary;
    if (l.name.length > 75) throw new Error(`${code}: name is ${l.name.length} chars (max 75)`);
    if (summary.length > 132) throw new Error(`${code}: summary is ${summary.length} chars (max 132)`);
    const dir = join(dist, "_locales", code);
    mkdirSync(dir, { recursive: true });
    const messages = {
      extName: { message: l.name, description: "Store and extension name" },
      extDescription: { message: summary, description: "Store summary (132 characters max)" },
      actionTitle: { message: "OpenKeyword", description: "Toolbar button tooltip" },
    };
    writeFileSync(join(dir, "messages.json"), `${JSON.stringify(messages, null, 2)}\n`);
  }
}

function writeStatic() {
  cpSync(join(root, "static"), dist, { recursive: true });
  // Apache-2.0: the license and notice travel with every copy, the store package included.
  for (const f of ["LICENSE", "NOTICE"]) cpSync(join(root, f), join(dist, f));
  mkdirSync(join(dist, "fonts"), { recursive: true });
  for (const [pkgName, file] of FONTS) cpSync(join(root, "node_modules/@fontsource", pkgName, "files", file), join(dist, "fonts", file));
  mkdirSync(join(dist, "icons"), { recursive: true });
  for (const s of [16, 32, 48, 128]) writeFileSync(join(dist, "icons", `${s}.png`), iconPng(s));
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest(), null, 2) + "\n");
  writeLocales();
}

const common = {
  bundle: true,
  minify: false,
  sourcemap: prod ? false : "linked",
  target: "chrome116",
  logLevel: "info",
  charset: "utf8",
  define: {
    __API_BASE__: JSON.stringify(API_BASE),
    __WEB_BASE__: JSON.stringify(WEB_BASE),
    __SITE_BASE__: JSON.stringify(SITE_BASE),
    __DEV__: JSON.stringify(!prod),
    __SOURCE_URL__: JSON.stringify(SOURCE_URL),
  },
};
const configs = [
  { ...common, entryPoints: { background: "src/background.ts" }, format: "esm", outdir: dist },
  { ...common, entryPoints: { popup: "src/popup.ts", onboarding: "src/onboarding.ts", login: "src/login.ts" }, format: "iife", outdir: dist },
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeStatic();
console.log(`${prod ? "prod" : "dev"} build, API ${API_BASE}, web ${WEB_BASE}, site ${SITE_BASE}, source ${SOURCE_URL || "(not public yet)"}`);

if (watch) {
  for (const c of configs) await (await esbuild.context({ ...c, absWorkingDir: root })).watch();
  console.log("watching for changes (Ctrl+C to stop)");
} else {
  for (const c of configs) await esbuild.build({ ...c, absWorkingDir: root });
  if (zip) writeZip();
}

// ---- release zip (store upload) --------------------------------------------------------------

/** Every file under dir, as paths relative to it, sorted so the zip lists files in a fixed order. */
function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), prefix + e.name + "/") : [prefix + e.name]))
    .sort();
}

/** Writes dist/ as a plain deflate zip (no dependencies). Refuses dev builds and source maps. */
function writeZip() {
  if (!prod) throw new Error("--zip needs --prod: the store must never get the dev build");
  const files = listFiles(dist);
  if (files.some((f) => f.endsWith(".map") || (f.startsWith("_") && !f.startsWith("_locales/")))) throw new Error("source maps or preview files in dist/; refusing to package");
  const local = [];
  const central = [];
  let offset = 0;
  for (const name of files) {
    const data = readFileSync(join(dist, name));
    const comp = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); // local file header
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(0x00210000, 10); // fixed DOS time/date (1980-01-01)
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory header
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0x00210000, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    local.push(head, nameBuf, comp);
    central.push(cen, nameBuf);
    offset += head.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  const outDir = join(root, "release");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `openkeyword-${pkg.version}.zip`);
  writeFileSync(out, Buffer.concat([...local, cenBuf, end]));
  console.log(`wrote ${out} (${files.length} files)`);
}
