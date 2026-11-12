/* FitX Gym Layout Planner – Cloud database (Firebase Auth + Firestore)
   Collections:
     plans/{id}        saved gym plans (client, room, doors, equipment, chosen layout)
     settings/catalog  custom equipment types + brands shared by the team
     users/{uid}       staff profile (name, email, last login)                       */

let AUTH = null, DB = null, ME = null, MYNAME = "", CUR_ID = null, PLANS = [], DIRTY = false;
let unsubPlans = null, unsubCat = null, CAT_FROM_CLOUD = false;
const IS_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

function fbConfig() { return window.FITX_FIREBASE || ls("fitxFirebaseConfig"); }
function parseConfig(txt) {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No { … } found");
  let s = m[0].replace(/\/\/.*$/gm, "").replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, "}");
  const c = JSON.parse(s);
  if (!c.apiKey || !c.projectId) throw new Error("apiKey / projectId missing");
  return c;
}

/* ---------- overlays ---------- */
function ov(id, show) { $(id).style.display = show ? "flex" : "none"; }
function showSetup() {
  const c = fbConfig();
  $("cfgText").value = c ? JSON.stringify(c, null, 2) : "";
  $("cfgErr").textContent = "";
  ov("setupOv", true);
}
function saveSetup() {
  try {
    const c = parseConfig($("cfgText").value);
    ls("fitxFirebaseConfig", c);
    location.reload();
  } catch (e) { $("cfgErr").textContent = "Could not read config: " + e.message; }
}
function lock(on) { document.body.classList.toggle("locked", on); }
function showLogin(msg) { lock(true); $("loginErr").textContent = msg || ""; ov("loginOv", true); setTimeout(() => $("liEmail").focus(), 50); }

/* ---------- start ---------- */
async function cloudInit() {
  const cfg = fbConfig();
  if (window.FITX_FIREBASE) $("setupLink").style.display = "none"; // config is built in – staff cannot change it
  showLogin();
  if (!cfg) { showSetup(); return; }
  try {
    await loadJS("lib/firebase-app-compat.js");
    await loadJS("lib/firebase-auth-compat.js");
    await loadJS("lib/firebase-firestore-compat.js");
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    AUTH = firebase.auth(); DB = firebase.firestore();
    try { await DB.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* another tab / not supported */ }
  } catch (e) { console.error(e); showSetup(); $("cfgErr").textContent = "Firebase could not start: " + e.message; return; }
  AUTH.onAuthStateChanged(u => {
    ME = u;
    if (u) onLogin(u);
    else { stopSync(); ROLE = ""; $("userBox").style.display = "none"; showLogin(); }
  });
}
async function doLogin(ev) {
  ev && ev.preventDefault();
  const e = $("liEmail").value.trim().toLowerCase(), p = $("liPass").value;
  if (!e || !p) { $("loginErr").textContent = "Enter email and password"; return; }
  $("liBtn").disabled = true; $("loginErr").textContent = "";
  try { await AUTH.signInWithEmailAndPassword(e, p); }
  catch (er) { $("loginErr").innerHTML = esc(niceErr(er)) + (/wrong|invalid/.test(er.code || "") ? "<br><small style='color:#666'>Tap 👁 to check the password. Capital letters matter.</small>" : "") + `<br><small style="color:#999">${esc(er.code || "")}</small>`; }
  finally { $("liBtn").disabled = false; }
}
async function forgotPass() {
  const e = $("liEmail").value.trim();
  if (!e) { $("loginErr").textContent = "Type your email first, then tap Forgot password"; return; }
  try { await AUTH.sendPasswordResetEmail(e); $("loginErr").style.color = "#2a8a2a"; $("loginErr").textContent = "Reset link sent to " + e; }
  catch (er) { $("loginErr").textContent = niceErr(er); }
  setTimeout(() => $("loginErr").style.color = "", 4000);
}
function niceErr(e) {
  const c = (e && e.code) || "";
  if (/wrong-password|invalid-credential|user-not-found|invalid-login/.test(c)) return "Wrong email or password";
  if (/too-many-requests/.test(c)) return "Too many tries – wait a few minutes";
  if (/network/.test(c)) return "No internet connection";
  if (/invalid-email/.test(c)) return "Email address is not valid";
  return (e && e.message) || String(e);
}
function logout() {
  if (DIRTY && !confirm("You have unsaved changes. Log out anyway?")) return;
  if (!DIRTY && !confirm("Log out of FitX Layout?")) return;
  // clear this device's working copy so the next person starts clean
  try { localStorage.removeItem("fitxLayout"); } catch (e) {}
  DIRTY = false; CUR_ID = null; Promise.resolve(AUTH.signOut()).then(() => location.reload());
}

/* ---------- access check: admin or active staff ---------- */
let ROLE = "", unsubStaff = null, STAFF = [];
const ADMINS = (window.FITX_ADMINS || []).map(e => e.toLowerCase());
async function onLogin(u) {
  const ts = firebase.firestore.FieldValue.serverTimestamp(), ref = DB.collection("users").doc(u.uid);
  const email = (u.email || "").toLowerCase();
  let doc = null;
  try { doc = await ref.get(); } catch (e) { doc = null; }
  const d = doc && doc.exists ? doc.data() : null;
  if (ADMINS.includes(email)) {
    ROLE = "admin";
    ref.set({ email, name: (d && d.name) || "Admin", role: "admin", active: true, lastLogin: ts }, { merge: true }).catch(console.warn);
    MYNAME = (d && d.name) || "Admin";
  } else if (d && d.active === true) {
    ROLE = d.role == "admin" ? "admin" : "staff";
    MYNAME = d.name || email.split("@")[0];
    ref.update({ lastLogin: ts }).catch(console.warn);
  } else {
    await AUTH.signOut();
    showLogin(d ? "Your account is disabled. Please contact the FitX admin." : "This login has no access. Please contact the FitX admin.");
    return;
  }
  ov("loginOv", false); lock(false);
  $("userName").textContent = MYNAME + (ROLE == "admin" && MYNAME != "Admin" ? " (Admin)" : "");
  $("userBox").style.display = "";
  $("staffBtn").style.display = ROLE == "admin" ? "" : "none";
  startSync();
}

/* ---------- staff management (admin only) ---------- */
function openStaff() { if (ROLE != "admin") return; $("stErr").textContent = ""; ov("staffOv", true); listenStaff(); }
function listenStaff() {
  if (unsubStaff) return;
  unsubStaff = DB.collection("users").onSnapshot(s => {
    STAFF = s.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    renderStaff();
  }, e => $("stErr").textContent = niceErr(e));
}
function renderStaff() {
  $("staffList").innerHTML = STAFF.map(m => {
    const me = ME && m.id == ME.uid, mainAdmin = ADMINS.includes((m.email || "").toLowerCase());
    return `<div class="plan${m.active ? "" : " off"}"><div class="pinfo"><b>${esc(m.name || "-")}</b> <span class="tagr ${m.role == "admin" ? "ad" : ""}">${m.role == "admin" ? "Admin" : "Staff"}</span>${m.active ? "" : ' <span class="tagr dis">Disabled</span>'}
      <div class="note">${esc(m.email || "")}</div><div class="note">Last login: ${m.lastLogin ? fmtDate(m.lastLogin) : "never"}</div></div>
      <div class="pact">${me || mainAdmin ? '<span class="note">main admin</span>' : `
        <button class="bg bs" onclick="staffActive('${m.id}',${!m.active})">${m.active ? "Disable" : "Enable"}</button>
        <button class="bg bs" onclick="staffRole('${m.id}','${m.role == "admin" ? "staff" : "admin"}')">${m.role == "admin" ? "Make staff" : "Make admin"}</button>
        <button class="bg bs" onclick="staffReset('${esc(m.email || "")}')">Reset pw</button>
        <button class="bx" title="Remove access" onclick="staffRemove('${m.id}')">🗑</button>`}</div></div>`;
  }).join("") || '<p class="note">No staff yet.</p>';
}
async function addStaff(ev) {
  ev && ev.preventDefault();
  const name = $("stName").value.trim(), email = $("stEmail").value.trim().toLowerCase(), pw = $("stPass").value, role = $("stRole").value;
  $("stErr").style.color = ""; $("stErr").textContent = "";
  if (!name || !email || !pw) { $("stErr").textContent = "Enter name, email and password"; return; }
  if (pw.length < 6) { $("stErr").textContent = "Password must be at least 6 characters"; return; }
  $("stBtn").disabled = true;
  let sec;
  try {
    sec = firebase.apps.find(a => a.name == "staffCreator") || firebase.initializeApp(fbConfig(), "staffCreator");
    const sa = sec.auth();
    await sa.setPersistence(firebase.auth.Auth.Persistence.NONE);
    const cred = await sa.createUserWithEmailAndPassword(email, pw);
    const uid = cred.user.uid;
    await sa.signOut();
    await DB.collection("users").doc(uid).set({ name, email, role, active: true, createdBy: MYNAME, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    $("stName").value = $("stEmail").value = $("stPass").value = "";
    $("stErr").style.color = "#2a8a2a"; $("stErr").textContent = `${name} added. Give them: ${email} + the password you typed.`;
  } catch (e) {
    const c = (e && e.code) || "";
    $("stErr").textContent = /email-already-in-use/.test(c) ? "This email already has a login. If it was removed, press Enable on it in the list, or use a different email."
      : /operation-not-allowed|admin-restricted/.test(c) ? "Creating logins is switched off in Firebase (User actions → Enable create)."
      : /weak-password/.test(c) ? "Password too weak – use at least 6 characters" : niceErr(e);
  } finally { $("stBtn").disabled = false; }
}
function staffActive(id, on) { DB.collection("users").doc(id).update({ active: on }).then(() => toast(on ? "Staff enabled" : "Staff disabled – they can no longer open the app")).catch(e => toast(niceErr(e))); }
function staffRole(id, role) { DB.collection("users").doc(id).update({ role }).then(() => toast(role == "admin" ? "Now an admin" : "Now staff")).catch(e => toast(niceErr(e))); }
function staffReset(email) { AUTH.sendPasswordResetEmail(email).then(() => toast("Password reset email sent to " + email)).catch(e => toast(niceErr(e))); }
function staffRemove(id) {
  const m = STAFF.find(x => x.id == id); if (!m) return;
  if (!confirm(`Remove ${m.name || m.email}? They will lose access to the app.`)) return;
  DB.collection("users").doc(id).update({ active: false, removed: true }).then(() => toast("Access removed")).catch(e => toast(niceErr(e)));
}

/* ---------- live sync ---------- */
function setSync(state) {
  const d = $("syncDot"); if (!d) return;
  d.style.background = state == "ok" ? "#3ecf5a" : state == "off" ? "#ffb400" : "#888";
  d.title = state == "ok" ? "Synced with cloud" : state == "off" ? "Offline – changes will sync when online" : "Connecting…";
}
function startSync() {
  stopSync(); setSync("wait");
  unsubPlans = DB.collection("plans").orderBy("updatedAt", "desc").onSnapshot({ includeMetadataChanges: true }, s => {
    PLANS = s.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    setSync(s.metadata.fromCache && !navigator.onLine ? "off" : s.metadata.hasPendingWrites ? "wait" : "ok");
    renderPlans();
  }, e => { console.error(e); toast("Database error: " + niceErr(e)); setSync("off"); });
  unsubCat = DB.collection("settings").doc("catalog").onSnapshot(d => {
    if (d.exists) {
      const c = d.data(); CT = c.types || {}; CB = c.brands || [];
      ls("fitxCustomTypes", CT); ls("fitxCustomBrands", CB); rebuildTypes(); renderCustom();
    } else if (Object.keys(CT).length || CB.length) saveCatalog(); // first time: upload this device's custom list
    CAT_FROM_CLOUD = true;
  }, console.warn);
}
function stopSync() { unsubPlans && unsubPlans(); unsubCat && unsubCat(); unsubStaff && unsubStaff(); unsubPlans = unsubCat = unsubStaff = null; PLANS = []; renderPlans(); }
function saveCatalog() {
  if (!DB || !ME) return;
  DB.collection("settings").doc("catalog").set({ types: CT, brands: CB, updatedBy: MYNAME, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(e => toast("Could not save list: " + niceErr(e)));
}
// share custom types/brands with the team
["addType", "delType", "addBrand", "delBrand"].forEach(fn => {
  const orig = window[fn];
  window[fn] = function () { orig.apply(this, arguments); saveCatalog(); };
});

/* ---------- plans ---------- */
function planData() {
  const P = read();
  return { ...P, location: $("loc").value.trim(), phone: $("phone").value.trim(), notes: $("notes").value.trim(), layout: SEL };
}
function setCurrent(id) {
  CUR_ID = id; DIRTY = false;
  const p = PLANS.find(x => x.id == id);
  $("curPlan").innerHTML = id ? `Editing: <b>${esc(p ? p.client || "Untitled" : $("client").value || "Untitled")}</b>` : "New plan (not saved yet)";
  $("dirty").style.display = "none";
  renderPlans();
}
async function savePlan(btn) {
  if (!DB || !ME) { showLogin(); return; }
  const d = planData();
  if (!d.client) { toast("Enter the client / site name first"); $("client").focus(); return; }
  btn && (btn.disabled = true);
  const ts = firebase.firestore.FieldValue.serverTimestamp();
  d.updatedAt = ts; d.updatedBy = MYNAME; d.updatedByUid = ME.uid;
  try {
    if (CUR_ID) await DB.collection("plans").doc(CUR_ID).set(d, { merge: true });
    else {
      d.createdAt = ts; d.createdBy = MYNAME; d.createdByUid = ME.uid;
      const ref = DB.collection("plans").doc(); // id now, works offline too
      CUR_ID = ref.id; ref.set(d);
    }
    setCurrent(CUR_ID); toast(navigator.onLine ? "Plan saved to cloud" : "Saved – will upload when online");
  } catch (e) { toast("Save failed: " + niceErr(e)); }
  finally { btn && (btn.disabled = false); }
}
function loadPlan(p) {
  $("client").value = p.client || ""; $("loc").value = p.location || ""; $("phone").value = p.phone || ""; $("notes").value = p.notes || "";
  $("rw").value = p.W || 10; $("rd").value = p.D || 8; $("rh").value = p.H || 3; $("gap").value = p.gap || 0.6;
  $("doors").innerHTML = ""; (p.doors || []).forEach(addDoor);
  $("eq").innerHTML = ""; (p.eq || []).forEach(e => addEq(e));
  SEL = p.layout || 0; SHOT = null; generate(); save();
}
function openPlan(id) {
  if (DIRTY && !confirm("You have unsaved changes. Open another plan anyway?")) return;
  const p = PLANS.find(x => x.id == id); if (!p) return;
  loadPlan(p); setCurrent(id); window.scrollTo({ top: 0, behavior: "smooth" }); toast("Opened: " + (p.client || "plan"));
}
function newPlan() {
  if (DIRTY && !confirm("You have unsaved changes. Start a new plan anyway?")) return;
  loadPlan({ client: "", W: 12, D: 9, H: 3, gap: 0.6, doors: [{ wall: "Opposite wall (bottom)", off: 1, w: 1.2 }], eq: [] });
  addEq(); setCurrent(null); window.scrollTo({ top: 0, behavior: "smooth" });
}
function copyPlan(id) {
  const p = PLANS.find(x => x.id == id); if (!p) return;
  loadPlan({ ...p, client: (p.client || "Plan") + " (copy)" }); setCurrent(null); DIRTY = true; $("dirty").style.display = "";
  toast("Copy made – change it and tap Save"); window.scrollTo({ top: 0, behavior: "smooth" });
}
async function delPlan(id) {
  const p = PLANS.find(x => x.id == id); if (!p) return;
  if (!confirm(`Delete plan "${p.client || "Untitled"}"? This cannot be undone.`)) return;
  try { await DB.collection("plans").doc(id).delete(); if (CUR_ID == id) setCurrent(null); toast("Plan deleted"); }
  catch (e) { toast("Delete failed: " + niceErr(e)); }
}
function fmtDate(t) {
  if (!t) return "";
  const d = t.toDate ? t.toDate() : new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function renderPlans() {
  const box = $("planList"); if (!box) return;
  const q = ($("planSearch").value || "").toLowerCase();
  const list = PLANS.filter(p => !q || [p.client, p.location, p.phone, p.updatedBy].join(" ").toLowerCase().includes(q));
  $("planCount").textContent = PLANS.length ? `${PLANS.length} plan${PLANS.length > 1 ? "s" : ""}` : "";
  if (!ME) { box.innerHTML = '<p class="note">Log in to see saved plans.</p>'; return; }
  if (!list.length) { box.innerHTML = `<p class="note">${PLANS.length ? "No plan matches your search." : "No saved plans yet. Fill in a plan above and tap <b>Save Plan</b>."}</p>`; return; }
  box.innerHTML = list.map(p => {
    const n = (p.eq || []).reduce((a, e) => a + (+e.q || 1), 0);
    return `<div class="plan${p.id == CUR_ID ? " cur" : ""}">
      <div class="pinfo" onclick="openPlan('${p.id}')"><b>${esc(p.client || "Untitled")}</b>${p.location ? ` <span class="note">· ${esc(p.location)}</span>` : ""}
        <div class="note">${p.W} × ${p.D} m · ${n} machines · Layout ${"ABC"[p.layout || 0]}</div>
        <div class="note">Updated ${fmtDate(p.updatedAt)}${p.updatedBy ? " by " + esc(p.updatedBy) : ""}</div></div>
      <div class="pact"><button class="bo bs" onclick="openPlan('${p.id}')">Open</button><button class="bg bs" onclick="copyPlan('${p.id}')">Copy</button><button class="bx" title="Delete" onclick="delPlan('${p.id}')">🗑</button></div>
    </div>`;
  }).join("");
}
document.addEventListener("input", e => {
  if (e.target.id == "planSearch" || e.target.closest(".ovl")) return;
  DIRTY = true; const d = $("dirty"); if (d) d.style.display = "";
});
document.addEventListener("click", e => { if (e.target.classList && e.target.classList.contains("bx") && e.target.closest("#doors,#eq")) { DIRTY = true; $("dirty").style.display = ""; } });
window.addEventListener("online", () => setSync("wait"));
window.addEventListener("offline", () => setSync("off"));
window.addEventListener("beforeunload", e => { if (DIRTY && ME) { e.preventDefault(); e.returnValue = ""; } });

/* ---------- import from first (offline) planner page ---------- */
function openImport() { $("impText").value = ""; $("impErr").textContent = ""; ov("importOv", true); setTimeout(() => $("impText").focus(), 50); }
function doImport() {
  let d;
  try { d = JSON.parse($("impText").value.trim()); } catch (e) { $("impErr").textContent = "That is not export text. Copy it again from the first page."; return; }
  const plan = d.plan || (d.eq ? d : null);
  if (!plan || !Array.isArray(plan.eq)) { $("impErr").textContent = "No plan found in this text."; return; }
  if (DIRTY && !confirm("You have unsaved changes. Replace them with the imported plan?")) return;
  // custom equipment types & brands – merge, keep existing
  let added = 0;
  if (d.types && typeof d.types == "object") for (const k in d.types) if (!CT[k] && !BASE_TYPES[k]) { const t = d.types[k]; if (t.length < 5) t[4] = 120; CT[k] = t; added++; }
  if (Array.isArray(d.brands)) d.brands.forEach(b => { if (b && !brands().includes(b)) { CB.push(b); added++; } });
  if (added) { ls("fitxCustomTypes", CT); ls("fitxCustomBrands", CB); rebuildTypes(); renderCustom(); saveCatalog(); }
  // older pages had no height – fill from the type
  plan.eq.forEach(e => { if (e.h == null) e.h = (TYPES[e.type] || TYPES.Other)[4]; });
  loadPlan({ H: 3, gap: 0.6, ...plan });
  setCurrent(null); DIRTY = true; $("dirty").style.display = "";
  ov("importOv", false); window.scrollTo({ top: 0, behavior: "smooth" });
  toast(`Imported ${plan.eq.length} equipment rows${added ? ` + ${added} custom types/brands` : ""} – check it, then tap 💾 Save Plan`);
  if (!plan.client) setTimeout(() => $("client").focus(), 400);
}

/* ---------- start ---------- */
(function () {
  const d = ls("fitxLayout");
  if (d) { $("loc").value = d.location || ""; $("phone").value = d.phone || ""; $("notes").value = d.notes || ""; }
  setCurrent(null);
  cloudInit();
})();
