/* sync.js — đồng bộ dữ liệu cả web với Firebase (đăng nhập Google + Firestore)
   Dùng chung cho index.html và my_archive.html.
   Việc duy nhất bạn cần làm: điền FIREBASE_CONFIG bên dưới. */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAveX7LQCZDnVr1ld4F42e6P0wTEE-l9WI",
  authDomain: "ltqspace.firebaseapp.com",
  projectId: "ltqspace",
  appId: "1:433872267299:web:053f0bdabff1638e502996"
};

const CDN = "https://www.gstatic.com/firebasejs/10.12.2/";
const PRE = ["archive_"];                 // chỉ đồng bộ các khóa bắt đầu bằng tiền tố này
const $ = id => document.getElementById(id);
const orig = Storage.prototype.setItem;
const isMine = k => PRE.some(p => String(k).startsWith(p));
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = k => Number(localStorage.getItem(k) || 0);
const dirty = () => localStorage.getItem("sync_dirty") == "1";
const configured = () => !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);

let fb = null, user = null, ref = null, unsub = null;
let state = "ok", err = "", open = false;
let edits = 0, applying = false, timer = null, lastPushRev = 0, lastOk = 0;
let conflict = null, pend = null, pendT = 0;

/* ---- ghi nhận mọi thay đổi dữ liệu của web ---- */
Storage.prototype.setItem = function (k, v) {
  orig.call(this, k, v);
  if (this === localStorage && isMine(k) && !applying) {
    edits++;
    orig.call(localStorage, "sync_dirty", "1");
    schedule();
    paint();
  }
};

const mine = () => {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (isMine(k)) o[k] = localStorage.getItem(k);
  }
  return o;
};
const hasLocal = () => {
  try { return JSON.parse(localStorage.getItem("archive_v1") || "[]").length > 0; } catch (e) { return false; }
};
const msg = x => {
  const c = (x && x.code) || "";
  if (c.includes("permission-denied")) return "Firestore từ chối: kiểm tra phần Rules và đảm bảo đăng nhập đúng tài khoản Google của bạn.";
  if (c.includes("popup-closed")) return "Bạn đã đóng cửa sổ đăng nhập.";
  if (c.includes("popup-blocked")) return "Trình duyệt chặn cửa sổ đăng nhập. Hãy cho phép cửa sổ bật lên rồi thử lại.";
  if (c.includes("unauthorized-domain")) return "Tên miền của web chưa được thêm vào Authorized domains trong Firebase.";
  return (x && (x.code || x.message)) || String(x);
};

function schedule() { clearTimeout(timer); timer = setTimeout(push, 1500); }

/* ---- đẩy dữ liệu lên cloud ---- */
async function push() {
  if (!user || !ref || conflict || pend) return;
  const e = edits, keys = mine();
  if (JSON.stringify(keys).length > 900000) { state = "err"; err = "Dữ liệu quá lớn (gần 1 MB), không đồng bộ được."; paint(); return; }
  const rev = Date.now();
  lastPushRev = rev; state = "sync"; paint();
  try {
    await fb.setDoc(ref, { keys, rev, email: user.email || "" });
    orig.call(localStorage, "sync_rev", String(rev));
    lastOk = rev;
    if (edits === e) orig.call(localStorage, "sync_dirty", "0"); else schedule();
    state = "ok"; err = "";
  } catch (x) { state = "err"; err = msg(x); }
  paint();
}

/* ---- kéo dữ liệu từ cloud về ---- */
function apply(r) {
  applying = true;
  try {
    Object.keys(r.keys || {}).forEach(k => { if (isMine(k) && typeof r.keys[k] == "string") orig.call(localStorage, k, r.keys[k]); });
    orig.call(localStorage, "sync_rev", String(r.rev));
    orig.call(localStorage, "sync_dirty", "0");
  } finally { applying = false; }
  conflict = null; lastOk = r.rev; state = "ok"; paint();
  location.reload();
}
function pull(r) {
  if (document.querySelector("dialog[open]")) {       // đang mở khung nhập: chờ đóng rồi mới cập nhật
    pend = r; paint();
    if (!pendT) pendT = setInterval(() => {
      if (!document.querySelector("dialog[open]") && pend) { const x = pend; pend = null; clearInterval(pendT); pendT = 0; apply(x); }
    }, 1000);
    return;
  }
  apply(r);
}

/* ---- so khớp máy này với cloud ---- */
async function reconcile(r) {
  const last = num("sync_rev"), d = dirty(), has = hasLocal();
  if (!r) {                                             // cloud chưa có gì
    if (has || d) await push(); else { state = "ok"; paint(); }
    return;
  }
  if (r.rev === last) {                                 // cloud không đổi từ lần sync trước
    if (d) await push(); else { state = "ok"; lastOk = last; paint(); }
    return;
  }
  if (!has || (last && !d)) { pull(r); return; }        // máy này trống, hoặc chỉ cloud có thay đổi
  conflict = r; state = "conflict"; open = true; paint(); // cả hai cùng đổi: hỏi người dùng
}
function onRemote(snap) {
  if (snap.metadata && snap.metadata.hasPendingWrites) return;
  const r = snap.exists() ? snap.data() : null;
  if (r && r.rev === lastPushRev) return;               // chính là bản vừa đẩy lên
  reconcile(r);
}

/* ---- giao diện ---- */
function paint() {
  const b = $("sync"), p = $("syncnote");
  if (!b) return;
  let st = !configured() ? "off" : !user ? "out" : pend ? "pend" : state;
  if (st == "ok" && dirty()) st = "sync";
  b.textContent = { off: "☁ chưa cấu hình", out: "☁ đăng nhập Google", ok: "☁ đã đồng bộ", sync: "☁ đang đồng bộ…", err: "☁ lỗi đồng bộ", conflict: "☁ cần chọn bản", pend: "☁ có dữ liệu mới" }[st];
  if (!p) return;
  const t = lastOk ? new Date(lastOk).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "—";
  const acct = user ? `Đã đăng nhập: ${esc(user.email)} · đồng bộ lúc ${t} ` : "";
  const btns = `<button data-sy="now">đồng bộ ngay</button><button data-sy="out">đăng xuất</button>`;
  let h = "";
  if (st == "off") h = "Chưa điền cấu hình Firebase trong file sync.js.";
  else if (st == "out") h = "Chưa đăng nhập. Bấm nút để đăng nhập Google và bật đồng bộ." + (err ? " " + esc(err) : "");
  else if (st == "conflict") h = `Dữ liệu trên máy này và trên cloud đều đã thay đổi khác nhau. Chọn bản muốn giữ: <button data-sy="local">giữ bản trên máy này</button><button data-sy="cloud">lấy bản trên cloud</button>`;
  else if (st == "pend") h = "Có dữ liệu mới từ thiết bị khác. Đóng khung đang mở để cập nhật.";
  else if (st == "err") h = esc(err) + " " + (user ? btns : "");
  else h = acct + btns;
  p.innerHTML = h;
  p.hidden = !(open || st == "conflict" || st == "err" || (st == "out" && err));
}
function wire() {
  const b = $("sync"), p = $("syncnote");
  if (!b) return;
  const css = document.createElement("style");
  css.textContent = "#syncnote{margin:12px 0 0;font-size:16px;color:var(--mute)}#syncnote button{border:1px solid var(--soft);background:none;border-radius:99px;padding:2px 12px;margin-left:8px;font:inherit;font-size:15px;color:var(--fg);cursor:pointer}";
  document.head.appendChild(css);
  b.onclick = async () => {
    if (!configured()) { open = !open; paint(); return; }
    if (!fb) return;
    if (!user) {
      err = "";
      try { await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider()); }
      catch (x) { err = msg(x); paint(); }
      return;
    }
    open = !open; paint();
  };
  if (p) p.addEventListener("click", e => {
    const t = e.target.closest("[data-sy]"); if (!t) return;
    const a = t.dataset.sy;
    if (a == "now") { clearTimeout(timer); push(); }
    else if (a == "out") { fb.signOut(fb.auth); open = false; }
    else if (a == "local") { conflict = null; push(); }
    else if (a == "cloud") { pull(conflict); }
  });
}

/* ---- khởi động ---- */
async function init() {
  wire(); paint();
  if (!configured()) return;
  const [a, au, fs] = await Promise.all([import(CDN + "firebase-app.js"), import(CDN + "firebase-auth.js"), import(CDN + "firebase-firestore.js")]);
  const app = a.initializeApp(FIREBASE_CONFIG);
  fb = { auth: au.getAuth(app), db: fs.getFirestore(app), GoogleAuthProvider: au.GoogleAuthProvider, signInWithPopup: au.signInWithPopup, signOut: au.signOut, doc: fs.doc, setDoc: fs.setDoc, onSnapshot: fs.onSnapshot };
  au.onAuthStateChanged(fb.auth, u => {
    user = u; if (unsub) { unsub(); unsub = null; } ref = null; err = ""; state = "ok";
    if (u) {
      ref = fb.doc(fb.db, "users", u.uid);
      unsub = fb.onSnapshot(ref, onRemote, x => { state = "err"; err = msg(x); paint(); });
      state = "sync";
    }
    paint();
  });
  addEventListener("online", () => { if (user && dirty()) push(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState == "hidden" && user && dirty()) { clearTimeout(timer); push(); } });
}
init().catch(x => { state = "err"; err = msg(x); paint(); });
