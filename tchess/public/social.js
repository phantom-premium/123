/* ============================================================
   ДРУЗЬЯ · ПРОФИЛИ · ДОСТИЖЕНИЯ · ПРИГЛАШЕНИЯ
   Загружается после app.js и пользуется его глобальными функциями
   (authToken, sendWS, showToast, mountTcPicker, escapeHtml …).
   ============================================================ */
"use strict";

const SOC = { friends: null, ownProfile: null, inviteTo: null, invitePending: null, invitePopId: null, invitePopTimer: null, achQueue: [], achBusy: false };

const $id = (id) => document.getElementById(id);
const esc = (v) => escapeHtml(v);

async function sapi(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } };
  }
}

function avatarHtml(name, size = "") {
  let h = 0;
  for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letter = esc(String(name || "?").trim().charAt(0).toUpperCase() || "?");
  return `<span class="mini-avatar ${size}" style="--h:${h}">${letter}</span>`;
}

function isLoggedIn() { return Boolean(isSyncedAccount && authToken); }

/* ---------------- ДРУЗЬЯ ---------------- */

function onFriendsPageShown() {
  const logged = isLoggedIn();
  $id("friendsGuest").hidden = logged;
  $id("friendsBody").hidden = !logged;
  if (logged) loadFriends();
}

async function loadFriends() {
  if (!isLoggedIn()) return;
  const r = await sapi("GET", "/api/friends");
  if (!r.ok) return;
  SOC.friends = r.data;
  renderFriends();
}

function setFriendsBadge(n) {
  const b = $id("friendsBadge");
  if (!b) return;
  b.textContent = n;
  b.hidden = !n;
}

function playerRow(u, actionsHtml) {
  const dot = `<i class="online-dot ${u.online ? "on" : ""}" title="${u.online ? "в сети" : "не в сети"}"></i>`;
  return `
    <div class="friend-row" data-uid="${esc(u.uid)}" data-pid="${esc(u.publicId || "")}">
      <button class="friend-main" type="button" data-act="profile">
        ${avatarHtml(u.name)}
        <span class="friend-text">
          <span class="friend-name">${esc(u.name)} ${dot}</span>
          <span class="friend-meta">${u.rating != null ? "★ " + esc(u.rating) + " · " : ""}ID ${esc(u.publicId || "")}</span>
        </span>
      </button>
      <span class="friend-actions">${actionsHtml || ""}</span>
    </div>`;
}

function renderFriends() {
  const d = SOC.friends || { friends: [], incoming: [], outgoing: [] };
  setFriendsBadge(d.incoming.length);

  $id("friendIncomingBlock").hidden = !d.incoming.length;
  $id("friendIncomingCount").textContent = d.incoming.length;
  $id("friendIncoming").innerHTML = d.incoming.map((u) =>
    playerRow(u, `<button class="btn btn-primary btn-sm" data-act="accept">Принять</button><button class="btn btn-ghost btn-sm" data-act="decline">✕</button>`)).join("");

  $id("friendCount").textContent = d.friends.length;
  $id("friendList").innerHTML = d.friends.length
    ? d.friends.map((u) => playerRow(u, `<button class="btn btn-secondary btn-sm" data-act="invite" ${u.online ? "" : "disabled"} title="${u.online ? "" : "Друг не в сети"}">⚔ Играть</button>`)).join("")
    : '<div class="empty-state">Пока никого. Найдите друга по имени или ID выше.</div>';

  $id("friendOutgoingBlock").hidden = !d.outgoing.length;
  $id("friendOutgoing").innerHTML = d.outgoing.map((u) =>
    playerRow(u, `<button class="btn btn-ghost btn-sm" data-act="cancel">Отозвать</button>`)).join("");
}

let friendSearchTimer = null;
async function runFriendSearch() {
  const q = $id("friendSearch").value.trim();
  const box = $id("friendSearchResults");
  if (q.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
  const r = await sapi("GET", "/api/users/search?q=" + encodeURIComponent(q));
  if ($id("friendSearch").value.trim() !== q) return; // пока шёл запрос, текст изменился
  box.hidden = false;
  if (!r.ok) { box.innerHTML = '<div class="empty-state">Не удалось выполнить поиск.</div>'; return; }
  const users = r.data.users || [];
  box.innerHTML = '<div class="list-title">Результаты поиска</div>' + (users.length
    ? users.map((u) => playerRow(u, relationButtons(u))).join("")
    : '<div class="empty-state">Никого не нашли. Попросите друга показать свой ID в профиле.</div>');
}

function relationButtons(u) {
  switch (u.relation) {
    case "friends": return `<span class="tag">друзья</span>`;
    case "request_sent": return `<span class="tag">заявка отправлена</span>`;
    case "request_received": return `<button class="btn btn-primary btn-sm" data-act="accept">Принять</button>`;
    default: return `<button class="btn btn-primary btn-sm" data-act="add">＋ В друзья</button>`;
  }
}

const FRIEND_ERRORS = {
  user_not_found: "Игрок не найден", self: "Нельзя добавить самого себя",
  too_many_requests: "Слишком много исходящих заявок", friends_limit: "Достигнут лимит друзей",
};

async function friendAction(act, uid, name) {
  if (!isLoggedIn()) { showToast("Войдите в аккаунт"); return; }
  if (act === "profile") { openPlayerProfile(uid); return; }
  if (act === "invite") { openInvite(uid, name); return; }
  let r;
  if (act === "add") {
    r = await sapi("POST", "/api/friends/request", { uid });
    if (r.ok) showToast(r.data.status === "accepted" ? "Вы теперь друзья! 🎉" : r.data.status === "already_friends" ? "Вы уже друзья" : "Заявка отправлена");
  } else if (act === "accept" || act === "decline") {
    r = await sapi("POST", "/api/friends/respond", { uid, accept: act === "accept" });
    if (r.ok) showToast(act === "accept" ? "Вы теперь друзья! 🎉" : "Заявка отклонена");
  } else if (act === "cancel" || act === "remove") {
    r = await sapi("POST", "/api/friends/remove", { uid });
    if (r.ok) showToast(act === "remove" ? "Удалён из друзей" : "Заявка отозвана");
  }
  if (r && !r.ok) showToast(FRIEND_ERRORS[r.data.error] || "Не получилось, попробуйте ещё раз");
  await loadFriends();
  if ($id("friendSearch") && $id("friendSearch").value.trim().length >= 2) runFriendSearch();
  // Открытая карточка игрока должна показать новое состояние.
  if (!$id("profileOverlay").hidden && SOC.sheetUid === uid) openPlayerProfile(uid, true);
}

function bindFriendsPage() {
  $id("friendSearch").addEventListener("input", () => {
    clearTimeout(friendSearchTimer);
    friendSearchTimer = setTimeout(runFriendSearch, 350);
  });
  $id("page-friends").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    const row = e.target.closest(".friend-row");
    if (!btn || !row || btn.disabled) return;
    friendAction(btn.dataset.act, row.dataset.uid, row.querySelector(".friend-name")?.textContent.trim());
  });
}

/* ---------------- ПРОФИЛЬ ЛЮБОГО ИГРОКА ---------------- */

// Контекст для полосок прогресса «ещё не получено» — считаем из данных профиля.
function achievementCtx(p) {
  const mg = (m) => (p.modes[m] && p.modes[m].games) || 0;
  return {
    gamesPlayed: p.gamesPlayed, wins: p.wins, streak: p.streak, rating: p.rating, puzzles: p.puzzlesSolved, friends: p.friendsCount,
    bulletGames: mg("bullet"), blitzGames: mg("blitz"), rapidGames: mg("rapid"), classicGames: mg("classic"),
    modesPlayed: TModes.CATEGORY_ORDER.filter((m) => mg(m) >= 3).length,
  };
}

function achievementGrid(p, { onlyEarned = false, limit = 0 } = {}) {
  const earned = new Map(p.achievements.map((a) => [a.code, a.earnedAt]));
  const ctx = achievementCtx(p);
  let defs = TAchievements.CATALOG.slice();
  // Полученные — вперёд, самые свежие первыми.
  defs.sort((a, b) => (earned.has(b.code) - earned.has(a.code)) || ((earned.get(b.code) || 0) - (earned.get(a.code) || 0)));
  if (onlyEarned) defs = defs.filter((d) => earned.has(d.code));
  if (limit) defs = defs.slice(0, limit);
  return defs.map((d) => {
    const got = earned.has(d.code);
    const prog = !got ? TAchievements.progress(d, ctx) : null;
    const pct = prog ? Math.round((prog[0] / prog[1]) * 100) : 0;
    const when = got ? new Date(earned.get(d.code)).toLocaleDateString("ru-RU") : "";
    return `
      <div class="ach-item tier-${d.tier} ${got ? "got" : "locked"}" title="${esc(d.desc)}">
        <div class="ach-icon">${d.icon}</div>
        <div class="ach-name">${esc(d.name)}</div>
        <div class="ach-desc">${got ? esc(when) : esc(d.desc)}</div>
        ${prog ? `<div class="ach-bar"><i style="width:${pct}%"></i></div><div class="ach-prog">${prog[0]} / ${prog[1]}</div>` : ""}
      </div>`;
  }).join("");
}

function trophyHtml(t) {
  const tier = t.place === 1 ? "gold" : t.place === 2 ? "silver" : "bronze";
  const names = { 1: "Чемпион", 2: "Серебро", 3: "Бронза" };
  return `<div class="trophy-chip">${typeof cupSvg === "function" ? cupSvg(tier, 54) : "🏆"}<b>${names[t.place]}</b><span>${esc(t.title)}</span><span class="dim">${esc(t.subtitle || "")}</span></div>`;
}

function profileSheetHtml(p) {
  const total = TAchievements.CATALOG.length;
  const modeCells = TModes.CATEGORY_ORDER.map((c) => {
    const m = p.modes[c];
    const k = TModes.CATEGORIES[c];
    return `<div class="mode-rating"><span class="mr-icon">${k.icon}</span><b>${m ? m.rating : "—"}</b><span class="mr-name">${k.name}</span><span class="mr-games">${m ? m.games + " парт." : "не играл"}</span></div>`;
  }).join("");

  let actions = "";
  if (p.relation === "self") actions = "";
  else if (!isLoggedIn()) actions = `<div class="tag">Войдите, чтобы добавить в друзья</div>`;
  else if (p.relation === "friends")
    actions = `<button class="btn btn-primary" data-sheet-act="invite" ${p.online ? "" : "disabled"}>⚔ Пригласить сыграть</button><button class="btn btn-ghost" data-sheet-act="remove">Убрать из друзей</button>`;
  else if (p.relation === "request_sent")
    actions = `<button class="btn btn-secondary" disabled>Заявка отправлена</button><button class="btn btn-ghost" data-sheet-act="cancel">Отозвать</button>`;
  else if (p.relation === "request_received")
    actions = `<button class="btn btn-primary" data-sheet-act="accept">Принять заявку</button><button class="btn btn-ghost" data-sheet-act="decline">Отклонить</button>`;
  else actions = `<button class="btn btn-primary" data-sheet-act="add">＋ Добавить в друзья</button>`;

  return `
    <div class="sheet-head">
      ${avatarHtml(p.name, "big")}
      <div class="sheet-name">${esc(p.name)} <i class="online-dot ${p.online ? "on" : ""}"></i></div>
      <div class="sheet-id">ID T-CHESS-${esc(p.publicId || "")}</div>
      ${p.desc ? `<div class="sheet-desc">${esc(p.desc)}</div>` : ""}
      <div class="sheet-rating">★ ${esc(p.rating)}</div>
    </div>
    ${actions ? `<div class="sheet-actions">${actions}</div>` : ""}

    ${p.trophies.length ? `<div class="sheet-title">Кубки</div><div class="trophy-row">${p.trophies.map(trophyHtml).join("")}</div>` : ""}

    <div class="sheet-title">Рейтинг по режимам</div>
    <div class="mode-rating-grid">${modeCells}</div>

    <div class="sheet-title">Статистика</div>
    <div class="stat-row stat-row-4">
      <div class="stat-card"><span class="stat-num">${p.gamesPlayed}</span><span class="stat-label">партий</span></div>
      <div class="stat-card"><span class="stat-num">${p.wins}</span><span class="stat-label">побед</span></div>
      <div class="stat-card"><span class="stat-num">${p.puzzlesSolved}</span><span class="stat-label">задач</span></div>
      <div class="stat-card"><span class="stat-num">${p.friendsCount}</span><span class="stat-label">друзей</span></div>
    </div>

    ${p.tournaments.length ? `<div class="sheet-title">Турниры</div>${p.tournaments.map((t) => `
      <div class="t-line"><span>${esc(t.title)} · ${esc(t.subtitle || "")}</span><b>${t.place ? t.place + " место" : t.status === "finished" ? "—" : "идёт"} · ${t.score} оч.</b></div>`).join("")}` : ""}

    <div class="sheet-title">Достижения <span class="count-pill">${p.achievements.length} / ${total}</span></div>
    <div class="ach-grid ach-grid-full">${achievementGrid(p)}</div>`;
}

async function openPlayerProfile(idOrUid, silent = false) {
  if (!silent) {
    $id("profileSheet").innerHTML = '<div class="empty-state">Загружаем профиль…</div>';
    $id("profileOverlay").hidden = false;
  }
  const r = await sapi("GET", "/api/profile/" + encodeURIComponent(idOrUid));
  if (!r.ok) {
    $id("profileSheet").innerHTML = '<div class="empty-state">Профиль не найден.</div>';
    return;
  }
  SOC.sheetUid = r.data.uid;
  SOC.sheetName = r.data.name;
  $id("profileSheet").innerHTML = profileSheetHtml(r.data);
}

function closeProfileSheet() { $id("profileOverlay").hidden = true; }

function bindProfileSheet() {
  $id("btnProfileClose").addEventListener("click", closeProfileSheet);
  $id("profileOverlay").addEventListener("click", (e) => { if (e.target === $id("profileOverlay")) closeProfileSheet(); });
  $id("profileSheet").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sheet-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.sheetAct;
    if (act === "invite") { closeProfileSheet(); openInvite(SOC.sheetUid, SOC.sheetName); return; }
    friendAction(act === "remove" ? "remove" : act, SOC.sheetUid, SOC.sheetName);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeProfileSheet(); });
}

/* ---------------- ВЛАДЕЛЕЦ: блок на странице «Профиль» ---------------- */

async function renderProfileExtra() {
  const box = $id("profileExtra");
  if (!box) return;
  if (!isLoggedIn() || !profile.uid) { box.hidden = true; $id("btnMyPublic").hidden = true; return; }
  $id("btnMyPublic").hidden = false;
  const r = await sapi("GET", "/api/profile/" + encodeURIComponent(profile.uid));
  if (!r.ok) return;
  const p = r.data;
  SOC.ownProfile = p;
  box.hidden = false;
  $id("profileModes").innerHTML = TModes.CATEGORY_ORDER.map((c) => {
    const m = p.modes[c], k = TModes.CATEGORIES[c];
    return `<div class="mode-rating"><span class="mr-icon">${k.icon}</span><b>${m ? m.rating : "—"}</b><span class="mr-name">${k.name}</span><span class="mr-games">${m ? m.games + " парт." : "не играл"}</span></div>`;
  }).join("");
  $id("profileAchCount").textContent = `${p.achievements.length} из ${TAchievements.CATALOG.length}`;
  $id("profileAch").innerHTML = p.achievements.length
    ? achievementGrid(p, { onlyEarned: true, limit: 6 })
    : '<div class="empty-state">Сыграйте первую партию — и достижения посыплются 🎖</div>';
}

function bindOwnerBlock() {
  $id("btnMyPublic").addEventListener("click", () => profile.uid && openPlayerProfile(profile.uid));
  $id("btnAllAch").addEventListener("click", () => profile.uid && openPlayerProfile(profile.uid));
  $id("profileTChessId").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(profile.publicId || ""); showToast("ID скопирован — отправьте его другу"); } catch { showToast("Ваш ID: " + profile.tchessId); }
  });
  // Каждый раз, когда обновляется экран профиля, обновляем и наш блок.
  const base = refreshProfileUI;
  refreshProfileUI = function () { base(); renderProfileExtra(); };
}

/* ---------------- ПОЛУЧЕНИЕ ДОСТИЖЕНИЙ (всплывашка) ---------------- */

function pumpAchievements() {
  if (SOC.achBusy || !SOC.achQueue.length) return;
  SOC.achBusy = true;
  const def = TAchievements.get(SOC.achQueue.shift());
  const pop = $id("achPop");
  if (!def) { SOC.achBusy = false; pumpAchievements(); return; }
  pop.innerHTML = `<div class="ach-pop-card tier-${def.tier}"><span class="ach-pop-icon">${def.icon}</span><div><div class="ach-pop-title">Новое достижение!</div><div class="ach-pop-name">${esc(def.name)}</div></div></div>`;
  pop.hidden = false;
  pop.classList.add("show");
  setTimeout(() => {
    pop.classList.remove("show");
    setTimeout(() => { pop.hidden = true; SOC.achBusy = false; pumpAchievements(); }, 300);
  }, 3200);
}

/* ---------------- ПРИГЛАШЕНИЕ СЫГРАТЬ ---------------- */

function openInvite(uid, name) {
  if (!isLoggedIn()) { showToast("Войдите в аккаунт"); return; }
  if (gameActive) { showToast("Сначала завершите текущую партию"); return; }
  SOC.inviteTo = uid;
  SOC.invitePending = null;
  $id("inviteTitle").textContent = `Пригласить: ${name || "друг"}`;
  mountTcPicker($id("invitePicker"));
  const send = $id("btnInviteSend");
  send.disabled = false;
  send.textContent = "Отправить приглашение";
  $id("inviteOverlay").hidden = false;
}

function closeInviteOverlay() {
  if (!$id("inviteOverlay") || $id("inviteOverlay").hidden) return;
  $id("inviteOverlay").hidden = true;
  SOC.inviteTo = null;
  SOC.invitePending = null;
}

function bindInviteOverlay() {
  $id("btnInviteSend").addEventListener("click", () => {
    if (!SOC.inviteTo) return;
    $id("btnInviteSend").disabled = true;
    $id("btnInviteSend").textContent = "Отправляем…";
    sendWhenOpen({ type: "invite_send", toUid: SOC.inviteTo, tc: tcSelection });
  });
  $id("btnInviteCancel").addEventListener("click", () => {
    if (SOC.invitePending) sendWS({ type: "invite_cancel", inviteId: SOC.invitePending });
    closeInviteOverlay();
  });
}

function hideInvitePop() {
  clearInterval(SOC.invitePopTimer);
  SOC.invitePopId = null;
  const pop = $id("invitePop");
  if (pop) { pop.hidden = true; pop.innerHTML = ""; }
}

function showInvitePop(msg) {
  hideInvitePop();
  SOC.invitePopId = msg.inviteId;
  const pop = $id("invitePop");
  const tc = msg.tc;
  pop.innerHTML = `
    <div class="invite-card">
      <div class="invite-who">${avatarHtml(msg.from.name)}<div><b>${esc(msg.from.name)}</b> зовёт вас сыграть
        <div class="invite-tc">${tc.category.icon} ${esc(tc.category.name)} ${esc(tc.label)} · товарищеская</div></div></div>
      <div class="invite-btns">
        <button class="btn btn-primary btn-sm" id="btnInvAccept">Принять</button>
        <button class="btn btn-ghost btn-sm" id="btnInvDecline">Отказаться</button>
      </div>
      <div class="invite-timer"><i id="invTimerBar"></i></div>
    </div>`;
  pop.hidden = false;
  const total = Math.max(1000, msg.expiresAt - Date.now());
  const bar = $id("invTimerBar");
  SOC.invitePopTimer = setInterval(() => {
    const left = msg.expiresAt - Date.now();
    if (left <= 0) { hideInvitePop(); return; }
    bar.style.width = Math.round((left / total) * 100) + "%";
  }, 250);
  $id("btnInvAccept").addEventListener("click", () => {
    if (gameActive) { showToast("Сначала завершите текущую партию"); return; }
    sendWS({ type: "invite_accept", inviteId: msg.inviteId });
    hideInvitePop();
  });
  $id("btnInvDecline").addEventListener("click", () => {
    sendWS({ type: "invite_decline", inviteId: msg.inviteId });
    hideInvitePop();
  });
  if (navigator.vibrate) { try { navigator.vibrate(120); } catch {} }
}

const INVITE_ERRORS = {
  not_friends: "Приглашать можно только друзей", offline: "Друг сейчас не в сети", busy: "Вы или друг уже играете партию",
  not_authed: "Войдите в аккаунт", expired: "Приглашение уже недействительно", sender_gone: "Друг уже ушёл", self: "Это вы 🙂",
};

/* ---------------- СООБЩЕНИЯ СЕРВЕРА ---------------- */

function handleSocialWS(msg) {
  switch (msg.type) {
    case "auth_ok":
      loadFriends(); // обновить счётчик заявок на значке
      return true;
    case "friend_request":
      showToast(`👋 ${msg.from.name} хочет дружить`, 3600);
      loadFriends();
      return true;
    case "friend_accepted":
      showToast(`🤝 ${msg.from.name} теперь ваш друг`, 3200);
      loadFriends();
      return true;
    case "achievements":
      SOC.achQueue.push(...msg.codes);
      pumpAchievements();
      renderProfileExtra();
      return true;
    case "invite_sent":
      SOC.invitePending = msg.inviteId;
      $id("btnInviteSend").textContent = "Ждём ответа…";
      return true;
    case "invite_received":
      showInvitePop(msg);
      return true;
    case "invite_closed":
      if (SOC.invitePopId === msg.inviteId) hideInvitePop();
      return true;
    case "invite_declined":
      closeInviteOverlay();
      showToast(`${msg.name} отказался от партии`);
      return true;
    case "invite_expired":
      closeInviteOverlay();
      showToast("Друг не ответил на приглашение");
      return true;
    case "invite_error":
      closeInviteOverlay();
      showToast(INVITE_ERRORS[msg.reason] || "Не удалось отправить приглашение");
      return true;
  }
  return false;
}

document.addEventListener("DOMContentLoaded", () => {
  bindFriendsPage();
  bindProfileSheet();
  bindOwnerBlock();
  bindInviteOverlay();
  renderProfileExtra();
});
