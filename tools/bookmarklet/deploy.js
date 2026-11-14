function perchanceLine(line) {
let i;
let escaped = false;
for (i = 0; i < line.length; i++) {
if (i !== 0 && line[i - 1] !== "\\") escaped = false;
if (line[i] === "\\") escaped = !escaped;
if (line[i] === "/" && !escaped && line[i + 1] === "/" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) break;
}
const kept = line.slice(0, i);
if (!/\S/.test(kept)) return { indent: 0, text: "" };
let spaces = 0;
for (const ch of kept) {
if (ch === " ") spaces += 1;
else if (ch === "\t") spaces += 2;
else break;
}
return { indent: spaces, text: kept.trim() };
}
const metaKeys = ["title", "description", "image", "tags", "header", "dynamic"];
function readMetaData(listText) {
const lines = String(listText).replace(/\r/g, "").split("\n").map(perchanceLine);
const at = lines.findIndex((l) => l.indent === 0 && l.text === "$meta");
if (at === -1) return null;
let end = lines.findIndex((l, i) => i > at && l.text && l.indent === 0);
if (end === -1) end = lines.length;
const block = lines.slice(at + 1, end);
if (block.some((l) => l.text && l.indent % 2 !== 0)) throw new Error("$meta has a line indented by an odd number of spaces, which the engine rejects");
const raw = ["$meta", ...block.map((l) => (l.text ? " ".repeat(l.indent) + l.text : ""))].join("\n");
const found = {};
let header = null;
let owner = null;
for (const l of block) {
if (!l.text) continue;
if (l.indent === 2) {
owner = null;
if (l.text.startsWith("dynamic(") || l.text.startsWith("async dynamic(")) {
owner = "dynamic";
continue;
}
const m = /^([A-Za-z_$][\w$]*)(?:\s*=\s*(.*))?$/.exec(l.text);
if (!m) throw new Error(`$meta has an item this tool cannot read: "${l.text.slice(0, 40)}"`);
const key = m[1];
if (!metaKeys.includes(key)) throw new Error(`$meta has "${key}", which Perchance does not know - the editor would show an error`);
if (key in found || (key === "header" && header)) throw new Error(`$meta names "${key}" twice`);
if (key === "header") {
if (m[2] !== undefined) throw new Error("$meta header has a value of its own instead of items");
header = {};
owner = "header";
continue;
}
if (key === "dynamic") throw new Error("$meta dynamic is a value, not a function; the editor would fail calling it");
if (m[2] === undefined) throw new Error(`$meta ${key} is a list rather than one value, so the editor would pick one at random`);
found[key] = m[2];
owner = key;
continue;
}
if (owner === "dynamic") continue;
if (owner === "header" && l.indent === 4) {
const m = /^(\w+)\s*=\s*(.*)$/.exec(l.text);
if (!m || m[1] !== "mode") throw new Error(`$meta header has "${l.text.slice(0, 40)}"; only mode is read here`);
if (m[2] === "normal" || m[2] === "minimal") header.mode = m[2];
continue;
}
throw new Error(`$meta ${owner || "(top)"} has an indented line this tool cannot read: "${l.text.slice(0, 40)}"`);
}
for (const [key, value] of Object.entries(found)) {
if (/[[\]{}\\^=]/.test(value)) throw new Error(`$meta ${key} contains list syntax ([ ] { } \\ ^ =), which the engine would evaluate`);
}
if (found.title === undefined) throw new Error("$meta has no static title; the editor would take one from the page's heading, which this tool cannot see");
let dynamic = null;
const kept = [];
let inFunction = false;
let headerIndent = null;
for (const line of raw.split("\n")) {
if (line.trim().startsWith("dynamic(") || line.trim().startsWith("async dynamic(")) {
inFunction = true;
headerIndent = line.length - line.replace(/^ +/g, "").length;
kept.push(line.trim().replace("dynamic(", "function dynamic(").replace("=>", " {"));
continue;
}
if (inFunction) {
const indent = line.length - line.replace(/^ +/g, "").length;
if (line.trim() && indent <= headerIndent) break;
kept.push(line);
}
}
if (inFunction) {
dynamic = `${kept.join("\n")}\n}`;
if (dynamic.length > 20000) throw new Error(`$meta dynamic() is ${dynamic.length} characters; Perchance drops it above 20,000`);
}
return {
title: found.title,
image: found.image ?? "",
description: found.description ?? "",
dynamic,
header,
tags: found.tags === undefined ? null : found.tags.slice(0, 1000).split(",").map((t) => t.trim()).filter(Boolean),
};
}
function readListImports(listText) {
const names = [];
for (const line of String(listText).replace(/\r/g, "").split("\n")) {
for (const m of perchanceLine(line).text.matchAll(/\{import:([a-z0-9-]+)\}/g)) {
if (!names.includes(m[1])) names.push(m[1]);
}
}
return names;
}
function readDerivedData(listText, liveImports) {
const generatorMetaData = readMetaData(listText);
if (!generatorMetaData) throw new Error("the list panel has no $meta");
const fromList = readListImports(listText);
if (!Array.isArray(liveImports)) throw new Error("this page does not show the server's import list, so the card cannot be checked against it; press Ctrl+S once in the editor");
const same = liveImports.length === fromList.length && fromList.every((name) => liveImports.includes(name));
if (!same) throw new Error(`the imports changed (server: ${liveImports.length}, panel: ${fromList.length}); press Ctrl+S once in the editor so it sends the card with the imports it sees`);
return { generatorMetaData, imports: [...liveImports], modelTextImports: [...liveImports] };
}
async function sendDerivedData({ generatorName, sourceRevision, derived, email, sessionToken }, waits = [3000, 8000]) {
const body = JSON.stringify({
generatorName,
sourceRevision,
generatorMetaData: derived.generatorMetaData,
imports: derived.imports,
modelTextImports: derived.modelTextImports,
email,
sessionToken,
});
for (let attempt = 0; ; attempt++) {
let text;
try {
const res = await fetch("/api/saveGeneratorDerivedData", {
method: "POST",
headers: { "Content-Type": "application/json" },
signal: AbortSignal.timeout?.(20000),
body,
});
text = await res.text();
} catch (err) {
return { status: null, detail: String(err && err.message) };
}
let status;
try {
status = JSON.parse(text).status ?? null;
} catch {
return { status: null, detail: text.slice(0, 200) };
}
if (status !== "stale" || attempt >= waits.length) return { status, detail: null };
await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
}
}
async function sourceRevision(name, modelText, outputTemplate) {
const bytes = new TextEncoder().encode(JSON.stringify([name, modelText, outputTemplate]));
const digest = await crypto.subtle.digest("SHA-256", bytes);
return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
(async () => {
const SOURCE_BASE = "https://raw.githubusercontent.com/AReiter96/perchance-live/main";
const EXPECTED_GENERATOR = "retold-ai";
const banner = (msg, ok) => {
document.querySelectorAll(".perchance-deploy-banner").forEach((el) => el.remove());
const el = document.createElement("div");
el.className = "perchance-deploy-banner";
el.style.cssText =
"position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:16px 20px;" +
"font:600 15px/1.45 system-ui,sans-serif;white-space:pre-wrap;cursor:pointer;" +
"box-shadow:0 2px 12px rgba(0,0,0,.35);color:#fff;background:" +
(ok ? "#1a7f37" : "#b3261e");
el.textContent = `${msg}\n\n(tap to dismiss)`;
el.onclick = () => el.remove();
document.body.appendChild(el);
console.log("[perchance-deploy]", msg);
};
try {
if (!location.hostname.endsWith("perchance.org")) {
banner("Run this on the perchance.org editor page for your generator.", false);
return;
}
const app = window.app;
if (!app?.data?.generator?.name) {
banner("The Perchance editor is not loaded yet. Wait for the page to finish, then tap again.", false);
return;
}
const name = app.data.generator.name;
if (name !== EXPECTED_GENERATOR) {
banner(
`Wrong page. This bookmarklet only deploys "${EXPECTED_GENERATOR}", but you are on "${name}".\n\n` +
`Open https://perchance.org/${EXPECTED_GENERATOR}#edit and tap again.`,
false,
);
return;
}
const user = app.store?.data?.user ?? {};
if (!user.sessionToken) {
banner("You are not logged in to Perchance in this browser. Log in, then tap again.", false);
return;
}
if (!confirm(`Deploy the latest committed source to "${name}"?\n\nThis overwrites both editor panels.`)) {
return;
}
banner("Fetching source from GitHub…", true);
const bust = `?t=${Date.now()}`;
const readPanel = async (r, what) => {
if (!r.ok) throw new Error(`${what} → HTTP ${r.status} (is the mirror public?)`);
const buf = new Uint8Array(await r.arrayBuffer());
if (buf[0] !== 0x1f || buf[1] !== 0x8b) return new TextDecoder().decode(buf);
if (typeof DecompressionStream === "undefined") {
throw new Error(`${what} arrived compressed and this browser cannot unpack it. Update the browser, or rebuild the bookmarklet against an uncompressed base.`);
}
return new Response(new Response(buf).body.pipeThrough(new DecompressionStream("gzip"))).text();
};
const [list, html] = await Promise.all([
fetch(`${SOURCE_BASE}/src/list.pchn${bust}`).then((r) => readPanel(r, "list.pchn")),
fetch(`${SOURCE_BASE}/src/index.html.gz${bust}`).then((r) => readPanel(r, "index.html.gz")),
]);
banner(`Saving ${list.length} + ${html.length} characters…`, true);
let derived = null;
let cardProblem = null;
try {
derived = readDerivedData(list, app.data.generator.imports);
} catch (err) {
cardProblem = err.message;
}
const generator = { ...app.data.generator, modelText: list, outputTemplate: html };
delete generator.srcManifest;
const body = {
email: user.email || "",
sessionToken: user.sessionToken,
generator,
lastKnownSaveTime: window.generatorLastSaveTime,
...(window.generatorSaveCountKnown ? { lastKnownSaveCount: window.generatorSaveCount } : {}),
};
const res = await fetch("/api/save", {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(body),
}).then((r) => r.json());
if (res.status === "captcha-needed") {
banner(
"Perchance is asking for a captcha.\n\nMake any small edit in the editor and press Ctrl+S / the Save button once — that shows the captcha widget. Then tap this again.",
false,
);
return;
}
if (res.status === "stale") {
banner("Rejected as stale: the generator changed in another tab.\n\nReload the page and tap again.", false);
return;
}
if (!["saved", "created", "success"].includes(res.status)) {
banner(`Save rejected by Perchance: ${res.status || JSON.stringify(res)}`, false);
return;
}
if (derived) {
banner("Saved. Sending the listing card…", true);
const card = await sendDerivedData({
generatorName: name,
sourceRevision: res.sourceRevision || (await sourceRevision(name, list, html)),
derived,
email: user.email || "",
sessionToken: user.sessionToken,
});
if (card.status !== "saved") cardProblem = card.status ? `the server answered "${card.status}"` : `no answer the tool could read (${card.detail})`;
}
banner(
`✓ Deployed to "${name}".\n\n` +
(cardProblem
? `⚠ The listing card, tags and ?char= previews were NOT updated: ${cardProblem}.\n` +
"The deploy itself is fine. To send them, reload this page and press Ctrl+S once."
: "The listing card, tags and ?char= previews were updated too.") +
"\n\nReload the page to see the new version in the editor.",
true,
);
} catch (err) {
banner(`Deploy failed: ${err.message}`, false);
console.error(err);
}
})();
