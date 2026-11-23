/* Кубок Unicum: страница турнира, таблица арены, SVG-кубок, админ-вкладки «Турниры» и «База». */
"use strict";

const CUP = { id: null, poll: null, tick: null, detail: null, queued: false, tab: "cup" };
let cupSvgN = 0;

function cupSvg(tier = "gold", size = 96) {
  const P = {
    gold: ["#F6E3A1", "#C9A24B", "#8A6818"], silver: ["#F1F4F8", "#AAB4C0", "#6E7885"],
    bronze: ["#E9B084", "#C07A45", "#7E4A24"], crystal: ["#E4F6FF", "#8FCDE8", "#3F8DB5"],
  }[tier] || [];
  const id = "cg" + ++cupSvgN;
  const rim = tier === "crystal" ? "#E4C878" : P[1];
  return `<svg width="${size}" height="${size * 1.15}" viewBox="0 0 120 138" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P[0]}"/><stop offset=".55" stop-color="${P[1]}"/><stop offset="1" stop-color="${P[2]}"/></linearGradient></defs>
    <path d="M30 30 C8 30 8 64 36 68" fill="none" stroke="url(#${id})" stroke-width="7" stroke-linecap="round"/>
    <path d="M90 30 C112 30 112 64 84 68" fill="none" stroke="url(#${id})" stroke-width="7" stroke-linecap="round"/>
    <path d="M28 18 H92 V50 C92 80 76 94 60 94 C44 94 28 80 28 50 Z" fill="url(#${id})"/>
    <rect x="26" y="14" width="68" height="8" rx="4" fill="${rim}"/>
    <rect x="54" y="94" width="12" height="20" fill="url(#${id})"/>
    <path d="M40 126 H80 L76 112 H44 Z" fill="url(#${id})"/>
    <rect x="34" y="124" width="52" height="9" rx="3" fill="${rim}"/>
    <text x="60" y="72" text-anchor="middle" font-size="34" fill="#1E1A16" fill-opacity=".75">♞</text>
    <text x="60" y="42" text-anchor="middle" font-size="13" fill="#fff" fill-opacity=".9">❄</text>
  </svg>`;
}

const fmtDur = (ms) => {
  ms = Math.max(0, ms); const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  const p = (n) => String(n).padStart(2, "0");
  return (d ? d + "д " : "") + `${p(Math.floor(s % 86400 / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`;
};
const fmtWhen = (ms) => new Date(ms).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const PHASE = { registration: "Регистрация открыта", live: "Идёт сейчас", finishing: "Доигрываются партии", finished: "Завершён", draft: "Черновик", cancelled: "Отменён" };

const CUP_ABOUT = `
  <details class="cup-about" OPEN>
    <summary>Как проходит Shahmatista Unicum Cup 2026</summary>
    <p>Зимний цифровой турнир в два этапа. Всё играется здесь, в приложении, а сервер сам ведёт часы и считает очки.</p>
    <div class="t-line"><span>❄️ Этап 1 · Снежная арена</span><b>60 мин · блиц 3+2 · все желающие</b></div>
    <div class="t-line"><span>🎿 Этап 2 · Финал «Хрустальный кубок»</span><b>50 мин · рапид 10+0 · топ-16</b></div>
    <p><b>Арена:</b> заходите в бой, когда хотите, сервер подбирает соперника. Победа — 2 очка, ничья — 1, поражение — 0. Две победы подряд включают «серию»: следующие победы стоят вдвое больше. Ничья короче 10 ходов очков не даёт.</p>
    <p><b>Награды:</b> золотой, серебряный и бронзовый Хрустальный кубок Unicum в вашем профиле, достижения «Участник», «Финалист», «Чемпион». Турнирные партии не меняют обычный рейтинг.</p>
    <div class="trophy-row">${["gold", "silver", "bronze"].map((t) => `<div class="trophy-chip">${cupSvg(t, 54)}</div>`).join("")}</div>
  </details>`;

function showTourTab(tab) {
  CUP.tab = tab;
  document.querySelectorAll("[data-tour-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tourTab === tab));
  $id("tourTabCup").hidden = tab !== "cup";
  $id("tourTabHistory").hidden = tab !== "history";
  if (tab === "history") loadTournaments();
}

async function onTournamentsPageShown() {
  if (!CUP.bound) {
    CUP.bound = true;
    document.querySelectorAll("[data-tour-tab]").forEach((b) => b.addEventListener("click", () => showTourTab(b.dataset.tourTab)));
    $id("cupList").addEventListener("click", (e) => { const c = e.target.closest("[data-cup]"); if (c) openCupDetail(c.dataset.cup); });
    $id("cupDetail").addEventListener("click", cupDetailClick);
  }
  showTourTab(CUP.tab);
  if (CUP.id) openCupDetail(CUP.id); else loadCupList();
}

async function loadCupList() {
  CUP.id = null; stopCupTimers();
  $id("cupDetail").hidden = true; $id("cupList").hidden = false;
  const r = await sapi("GET", "/api/tournaments");
  const list = r.ok ? r.data.tournaments : [];
  $id("cupList").innerHTML = (list.length ? list.map((t) => `
    <button class="cup-card" type="button" data-cup="${esc(t.id)}">
      <div class="cup-card-art">${cupSvg(t.stage === "final" ? "crystal" : "silver", 70)}</div>
      <div class="cup-card-body">
        <div class="cup-card-title">${esc(t.title)}</div>
        <div class="cup-card-sub">${esc(t.subtitle)}</div>
        <div class="cup-card-meta">${esc(PHASE[t.phase] || t.phase)} · ${esc(fmtWhen(t.startsAt))}</div>
        <div class="cup-card-meta">${t.tc.category.icon} ${esc(t.tc.label)} · ${t.durationMin} мин · 👥 ${t.playersCount}${t.joined ? " · ✅ вы участвуете" : ""}</div>
      </div></button>`).join("")
    : `<div class="cup-hero">${cupSvg("crystal", 120)}<h2>Shahmatista Unicum Cup 2026</h2><p>Зимний цифровой турнир скоро начнётся. Регистрация откроется здесь — следите за новостями!</p></div>`) + CUP_ABOUT;
}

function openCupDetail(id) {
  CUP.id = id; CUP.detail = null;
  $id("cupList").hidden = true; $id("cupDetail").hidden = false;
  $id("cupDetail").innerHTML = '<div class="empty-state">Загружаем…</div>';
  refreshCupDetail();
  stopCupTimers();
  CUP.poll = setInterval(() => { if (!document.hidden && CUP.id) refreshCupDetail(); }, 8000);
  CUP.tick = setInterval(updateCupClock, 1000);
}
function stopCupTimers() { clearInterval(CUP.poll); clearInterval(CUP.tick); }

async function refreshCupDetail() {
  const id = CUP.id; if (!id) return;
  const r = await sapi("GET", "/api/tournaments/" + encodeURIComponent(id));
  if (id !== CUP.id) return;
  if (!r.ok) { $id("cupDetail").innerHTML = '<button class="btn btn-ghost" data-cup-back>← Назад</button><div class="empty-state">Турнир недоступен.</div>'; return; }
  CUP.detail = { ...r.data, skew: r.data.tournament.now - Date.now() };
  if (r.data.me.queued) CUP.queued = true;
  renderCupDetail();
}

function cupActionHtml(d) {
  const t = d.tournament, me = d.me, live = t.phase === "live";
  if (t.phase === "finished" || t.phase === "finishing") return t.phase === "finished" ? "" : '<div class="tag">Доигрываются последние партии</div>';
  if (!isLoggedIn()) return '<button class="btn btn-primary btn-block" data-cup-act="login">Войти, чтобы участвовать</button>';
  if (live) {
    if (t.stage === "final" && !me.joined) return '<div class="tag">Финал — только для лучших игроков квалификации</div>';
    return CUP.queued
      ? '<div class="cup-queue">🔎 Ищем соперника…</div><button class="btn btn-ghost btn-block" data-cup-act="pause">Пауза</button>'
      : '<button class="btn btn-primary btn-block" data-cup-act="play">⚔ В БОЙ</button>';
  }
  if (t.stage === "final") return me.joined ? '<div class="tag">✅ Вы в финале! Приходите к началу</div>' : '<div class="tag">Финал — только для лучших игроков квалификации</div>';
  return me.joined
    ? '<div class="tag">✅ Вы зарегистрированы</div><button class="btn btn-ghost btn-block" data-cup-act="leave">Отменить участие</button>'
    : '<button class="btn btn-primary btn-block" data-cup-act="join">Участвовать</button>';
}

function renderCupDetail() {
  const d = CUP.detail; if (!d) return;
  const t = d.tournament, uid = profile.uid;
  const rows = d.standings.map((p) => `
    <tr class="${p.uid === uid ? "me" : ""}" data-pid="${esc(p.publicId || p.uid)}">
      <td>${p.place || p.rank}</td>
      <td class="st-name">${t.stage === "qualifier" && p.rank <= t.qualifyTop && p.games ? "🎿 " : ""}${esc(p.name)}${p.playing ? " <i class='online-dot on'></i>" : ""}</td>
      <td>${p.games}</td><td><b>${p.score}</b></td></tr>`).join("");
  const podium = t.phase === "finished" ? `<div class="trophy-row">${d.standings.slice(0, 3).map((p, i) =>
    `<div class="trophy-chip">${cupSvg(["gold", "silver", "bronze"][i], 54)}<b>${i + 1} место</b><span>${esc(p.name)}</span></div>`).join("")}</div>` : "";
  $id("cupDetail").innerHTML = `
    <button class="btn btn-ghost btn-sm" data-cup-back>← Все этапы</button>
    <div class="cup-hero">${cupSvg(t.stage === "final" ? "crystal" : "silver", 100)}
      <h2>${esc(t.title)}</h2><div class="cup-card-sub">${esc(t.subtitle)}</div>
      <div class="tag">${esc(PHASE[t.phase] || t.phase)}</div>
      <div class="cup-clock" id="cupClock"></div>
      <div class="cup-card-meta">${esc(fmtWhen(t.startsAt))} (ваше время) · ${t.tc.category.icon} ${esc(t.tc.category.name)} ${esc(t.tc.label)} · ${t.durationMin} мин</div>
      <div class="cup-card-meta">👥 ${t.playersCount} участников${t.phase === "live" ? ` · в очереди ${d.live.waiting}, играют ${d.live.playing}` : ""}</div>
    </div>
    ${d.me.joined && t.phase !== "registration" ? `<div class="t-line"><span>Вы: место ${d.me.rank || "—"}</span><b>${d.me.score} оч. · ${d.me.wins}П ${d.me.draws}Н ${d.me.losses}П${d.me.streak >= 2 ? " 🔥" : ""}</b></div>` : ""}
    <div class="cup-actions">${cupActionHtml(d)}</div>
    ${podium}
    <div class="sheet-title">Таблица</div>
    ${rows ? `<div class="table-wrap"><table class="standings"><thead><tr><th>#</th><th>Игрок</th><th>Парт.</th><th>Очки</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state">Участников пока нет.</div>'}
    <details class="cup-about"><summary>Регламент</summary>${esc(t.description).split("\n").map((l) => `<p>${l}</p>`).join("")}</details>`;
  updateCupClock();
}

function updateCupClock() {
  const el = $id("cupClock"), d = CUP.detail; if (!el || !d) return;
  const t = d.tournament, now = Date.now() + d.skew;
  el.textContent = t.phase === "registration" ? "До старта: " + fmtDur(t.startsAt - now)
    : t.phase === "live" ? "Осталось: " + fmtDur(t.endsAt - now) : "";
  if (t.phase === "registration" && now >= t.startsAt + 1000) refreshCupDetail();
}

async function cupDetailClick(e) {
  if (e.target.closest("[data-cup-back]")) { loadCupList(); return; }
  const row = e.target.closest("tr[data-pid]"); if (row) { openPlayerProfile(row.dataset.pid); return; }
  const b = e.target.closest("[data-cup-act]"); if (!b || !CUP.detail) return;
  const id = CUP.id, act = b.dataset.cupAct;
  if (act === "login") { $id("btnAuth").click(); return; }
  if (act === "play") { if (gameActive) { showToast("Сначала завершите текущую партию"); return; } sendWhenOpen({ type: "t_ready", tid: id }); return; }
  if (act === "pause") { sendWS({ type: "t_pause", tid: id }); return; }
  const r = await sapi("POST", `/api/tournaments/${encodeURIComponent(id)}/${act}`);
  const E = { full: "Мест больше нет", invite_only: "Только для финалистов", ended: "Турнир уже закончился", too_late: "Поздно: турнир стартовал" };
  showToast(r.ok ? (act === "join" ? "Вы зарегистрированы! 🏆" : "Участие отменено") : E[r.data.error] || "Не получилось");
  refreshCupDetail();
}

function handleCupWS(msg) {
  const E = { login_required: "Войдите в аккаунт", not_running: "Турнир сейчас не идёт", busy: "Сначала завершите партию", invite_only: "Только для финалистов", full: "Мест больше нет" };
  switch (msg.type) {
    case "t_queued": CUP.queued = true; showToast("🔎 Ищем соперника…"); break;
    case "t_paused": CUP.queued = false; if (msg.why === "idle") showToast("⏸ Пауза: партия отменена — нет первого хода", 3600); break;
    case "t_error": CUP.queued = false; showToast(E[msg.reason] || "Ошибка турнира"); break;
    case "t_over": CUP.queued = false; showToast(msg.why === "cancelled" ? "Турнир отменён" : "🏁 Турнир завершён!", 3600); break;
    case "t_started": showToast(`🏆 Старт: ${msg.title} (${msg.tc})`, 4200); break;
    case "t_finished": break;
    case "cup_qualified": showToast(`🎿 Вы в финале Кубка! (${msg.place} место)`, 4200); break;
    default: return false;
  }
  if (CUP.id && !$id("page-tournaments").hidden) refreshCupDetail();
  return true;
}

/* ---------------- АДМИН: вкладки «Турниры» и «База» ---------------- */
const ADM = { tours: [], editing: null };

function bindAdminTabs() {
  const seg = $id("adminSeg"); if (!seg) return;
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-atab]"); if (!b) return;
    seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    $id("adminTabPuzzles").hidden = b.dataset.atab !== "puzzles";
    $id("adminTabTours").hidden = b.dataset.atab !== "tours";
    $id("adminTabDb").hidden = b.dataset.atab !== "db";
    if (b.dataset.atab === "tours") loadAdminTours();
    if (b.dataset.atab === "db") loadAdminDb();
  });
  $id("adminTabTours").addEventListener("click", adminToursClick);
}

async function loadAdminTours() {
  const r = await sapi("GET", "/api/admin/tournaments");
  ADM.tours = r.ok ? r.data.tournaments : []; ADM.editing = null; renderAdminTours();
}

function renderAdminTours() {
  const box = $id("adminTabTours");
  if (ADM.editing) { box.innerHTML = adminTourForm(ADM.editing); return; }
  box.innerHTML = `<button class="btn btn-primary btn-block" data-tact="new">＋ Новый турнир</button><div class="admin-list">` + ADM.tours.map((t) => `
    <div class="admin-item" data-id="${esc(t.id)}">
      <div><div class="admin-item-title">${esc(t.title)} · ${esc(t.subtitle)}</div>
      <div class="admin-item-meta">${esc(t.status)} · ${esc(fmtWhen(t.startsAt))} · ${esc(t.tc.label)} · ${t.durationMin} мин · 👥 ${t.playersCount}</div></div>
      <div class="admin-item-actions">
        <button class="btn btn-secondary btn-sm" data-tact="edit">Править</button>
        ${t.status === "draft" ? '<button class="btn btn-primary btn-sm" data-tact="open">Открыть регистрацию</button>' : ""}
        ${t.stage === "final" && (t.status === "draft" || t.status === "registration") ? '<button class="btn btn-secondary btn-sm" data-tact="seed">Занести финалистов</button>' : ""}
        ${t.status !== "finished" && t.status !== "cancelled" ? '<button class="btn btn-ghost btn-sm" data-tact="cancel">Отменить</button>' : ""}
      </div></div>`).join("") + "</div>";
}

const toLocalInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

function adminTourForm(t) {
  const f = (id, label, val, type = "text", extra = "") => `<label class="auth-label">${label}</label><input class="auth-input" id="at_${id}" type="${type}" value="${esc(val)}" ${extra} />`;
  const tcs = TModes.list().map((c) => `<option value="${c.id}" ${c.id === t.tc ? "selected" : ""}>${c.category.name} ${c.label}</option>`).join("");
  const parents = '<option value="">—</option>' + ADM.tours.filter((x) => x.id !== t.id).map((x) => `<option value="${esc(x.id)}" ${x.id === t.parentId ? "selected" : ""}>${esc(x.subtitle || x.title)}</option>`).join("");
  return `<h3 class="admin-title">${t.id ? "Правка турнира" : "Новый турнир"}</h3>
    ${f("title", "Название", t.title || "")}${f("subtitle", "Этап / подзаголовок", t.subtitle || "")}
    <label class="auth-label">Тип</label><select class="auth-input" id="at_stage">${["single", "qualifier", "final"].map((s) => `<option ${s === t.stage ? "selected" : ""}>${s}</option>`).join("")}</select>
    ${f("startsAt", "Начало (ваше время)", toLocalInput(t.startsAt || Date.now() + 864e5), "datetime-local")}
    ${f("durationMin", "Длительность, минут", t.durationMin || 60, "number")}
    <label class="auth-label">Контроль времени</label><select class="auth-input" id="at_tc">${tcs}</select>
    ${f("maxPlayers", "Максимум участников", t.maxPlayers || 500, "number")}
    ${f("qualifyTop", "Сколько проходит в финал", t.qualifyTop || 16, "number")}
    <label class="auth-label">Предыдущий этап (для финала)</label><select class="auth-input" id="at_parentId">${parents}</select>
    <label class="auth-label">Регламент (по строке на пункт)</label><textarea class="auth-input admin-textarea" id="at_description" rows="6">${esc(t.description || "")}</textarea>
    <div class="admin-status" id="atStatus"></div>
    <div class="admin-actions"><button class="btn btn-ghost" data-tact="back">Назад</button><button class="btn btn-primary" data-tact="save">Сохранить</button></div>`;
}

async function adminToursClick(e) {
  const b = e.target.closest("[data-tact]"); if (!b) return;
  const act = b.dataset.tact, id = b.closest(".admin-item")?.dataset.id;
  const say = (m, ok) => { const s = $id("atStatus"); if (s) { s.textContent = m; s.className = "admin-status " + (ok ? "ok" : "err"); } else showToast(m); };
  if (act === "new") { ADM.editing = { stage: "single" }; renderAdminTours(); return; }
  if (act === "back") { loadAdminTours(); return; }
  if (act === "edit") { ADM.editing = { ...ADM.tours.find((t) => t.id === id), tc: ADM.tours.find((t) => t.id === id).tcId }; renderAdminTours(); return; }
  if (act === "save") {
    const g = (k) => $id("at_" + k).value;
    const body = { title: g("title"), subtitle: g("subtitle"), stage: g("stage"), startsAt: new Date(g("startsAt")).getTime(), durationMin: Number(g("durationMin")),
      tc: g("tc"), maxPlayers: Number(g("maxPlayers")), qualifyTop: Number(g("qualifyTop")), parentId: g("parentId") || null, description: g("description") };
    const r = ADM.editing.id ? await sapi("PUT", "/api/admin/tournaments/" + ADM.editing.id, body) : await sapi("POST", "/api/admin/tournaments", body);
    if (r.ok) { showToast("Сохранено"); loadAdminTours(); } else say(r.data.message || "Не удалось сохранить", false);
    return;
  }
  const url = `/api/admin/tournaments/${encodeURIComponent(id)}/${act}`;
  if (act === "cancel" && !confirm("Отменить турнир?")) return;
  if (act === "open" && !confirm("Открыть регистрацию? Турнир станет виден всем игрокам.")) return;
  const r = await sapi("POST", url);
  showToast(r.ok ? (act === "seed" ? `Занесено финалистов: ${r.data.seeded}` : "Готово") : r.data.message || "Не получилось: " + (r.data.error || r.status));
  loadAdminTours();
}

async function loadAdminDb() {
  const box = $id("adminTabDb"); box.innerHTML = '<div class="empty-state">Проверяем базу…</div>';
  const r = await sapi("GET", "/api/admin/db-status");
  if (!r.ok) { box.innerHTML = '<div class="empty-state">Не удалось получить статус.</div>'; return; }
  const d = r.data, names = { users: "Игроков", games: "Партий", puzzles: "Задач", puzzle_solves: "Решений задач", friendships: "Дружб", tournaments: "Турниров", tournament_players: "Участий в турнирах" };
  box.innerHTML = `<div class="t-line"><span>Хранилище</span><b>${d.mode === "postgres" ? "✅ Postgres (постоянное)" : "⚠️ JSON-файлы (временное!)"}</b></div>
    ${Object.entries(d.counts).map(([k, v]) => `<div class="t-line"><span>${names[k] || k}</span><b>${v ?? "—"}</b></div>`).join("")}
    <div class="sheet-title">Миграции схемы (${d.migrations.length})</div>
    ${d.migrations.map((m) => `<div class="t-line"><span>#${m.id} ${esc(m.name)}</span><b>${new Date(m.appliedAt).toLocaleDateString("ru-RU")}</b></div>`).join("") || '<div class="empty-state">—</div>'}
    <div class="sheet-title">Страховочные копии перед миграциями</div>
    ${d.snapshots.length ? d.snapshots.map((s) => `<div class="t-line"><span>${esc(s)}</span></div>`).join("") : '<div class="empty-state">Копий нет (миграции, меняющие данные, ещё не запускались).</div>'}`;
}

document.addEventListener("DOMContentLoaded", bindAdminTabs);
