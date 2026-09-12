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
banner(`✓ Deployed to "${name}".\n\nReload the page to see the new version in the editor.`, true);
} catch (err) {
banner(`Deploy failed: ${err.message}`, false);
console.error(err);
}
})();
