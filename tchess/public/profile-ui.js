/* Экран «Профиль»: главный экран + отдельные вложенные экраны
   (рейтинги, достижения, о себе, тема). Только переключение показа —
   вся логика данных остаётся в app.js и social.js. */
(function () {
  const VIEWS = ["main", "modes", "ach", "edit", "theme", "account"];

  function showProfileView(name) {
    if (!VIEWS.includes(name)) name = "main";
    document.querySelectorAll("#page-profile .pview").forEach((v) => {
      v.hidden = v.dataset.pview !== name;
    });
    window.scrollTo(0, 0);
    if (name === "account") loadAccount();
  }

  /* ---------- экран «Аккаунт»: имя, e-mail, пароль ---------- */
  const $ = (id) => document.getElementById(id);
  const ERR = {
    wrong_password: "Текущий пароль указан неверно", email_taken: "Этот e-mail уже используется",
    invalid_email: "Некорректный e-mail", weak_password: "Новый пароль — минимум 6 символов",
    invalid_name: "Имя — от 2 до 40 символов", same_password: "Новый пароль совпадает с текущим",
    too_many_attempts: "Слишком много попыток. Попробуйте через 15 минут.", network: "Нет связи с сервером",
  };
  function say(id, text, ok) {
    const el = $(id);
    el.textContent = text; el.hidden = !text;
    el.className = "acc-msg " + (ok ? "ok" : "err");
  }
  const errText = (r) => (r.data && (r.data.message || ERR[r.data.error])) || "Не получилось, попробуйте ещё раз";

  async function loadAccount() {
    ["msgName", "msgEmail", "msgPassword"].forEach((id) => say(id, "", true));
    $("accName").value = profile.name || "";
    $("accEmailNow").textContent = "Текущий: …";
    const r = await sapi("GET", "/api/me");
    if (r.ok) $("accEmailNow").textContent = "Текущий: " + (r.data.email || "не указан");
  }

  function bindAccountForms() {
    $("formName").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("accName").value.trim();
      const r = await sapi("POST", "/api/profile/name", { name });
      if (!r.ok) return say("msgName", errText(r), false);
      profile.name = r.data.name;
      refreshProfileUI();
      say("msgName", "Имя изменено ✅", true);
      showToast("Имя изменено");
    });

    $("formEmail").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await sapi("POST", "/api/account/email", { email: $("accNewEmail").value.trim(), currentPassword: $("accEmailPass").value });
      if (!r.ok) return say("msgEmail", errText(r), false);
      $("accEmailNow").textContent = "Текущий: " + r.data.email;
      $("accNewEmail").value = ""; $("accEmailPass").value = "";
      say("msgEmail", "E-mail изменён ✅ — входите теперь с новым адресом", true);
    });

    $("formPassword").addEventListener("submit", async (e) => {
      e.preventDefault();
      const n1 = $("accNewPass").value, n2 = $("accNewPass2").value;
      if (n1 !== n2) return say("msgPassword", "Новые пароли не совпадают", false);
      const r = await sapi("POST", "/api/account/password", { currentPassword: $("accOldPass").value, newPassword: n1 });
      if (!r.ok) return say("msgPassword", errText(r), false);
      ["accOldPass", "accNewPass", "accNewPass2"].forEach((id) => { $(id).value = ""; });
      say("msgPassword", "Пароль изменён ✅", true);
      showToast("Пароль изменён");
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const page = document.getElementById("page-profile");
    if (!page) return;
    bindAccountForms();
    page.addEventListener("click", (e) => {
      const b = e.target.closest("[data-goto]");
      if (b) showProfileView(b.dataset.goto);
    });

    // «Сохранить» на экране «О себе» — после сохранения возвращаемся назад.
    const save = document.getElementById("btnSaveDesc");
    if (save) save.addEventListener("click", () => setTimeout(() => showProfileView("main"), 350));
  });

  // Каждый раз при входе на вкладку «Профиль» открываем главный экран.
  const baseSwitch = window.switchPage;
  if (typeof baseSwitch === "function") {
    window.switchPage = function (name) {
      const r = baseSwitch.apply(this, arguments);
      if (name === "profile") showProfileView("main");
      return r;
    };
  }

  // Короткое описание и подсказка для гостя на главном экране.
  const baseRefresh = window.refreshProfileUI;
  if (typeof baseRefresh === "function") {
    window.refreshProfileUI = function () {
      const r = baseRefresh.apply(this, arguments);
      try {
        const desc = (document.getElementById("profileDesc").value || "").trim();
        const bio = document.getElementById("profileBio");
        bio.textContent = desc;
        bio.hidden = !desc;
        document.getElementById("profileGuestHint").hidden = Boolean(isSyncedAccount);
      } catch (_) {}
      return r;
    };
  }
})();
