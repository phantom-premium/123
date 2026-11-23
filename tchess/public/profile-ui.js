/* Экран «Профиль»: главный экран + отдельные вложенные экраны
   (рейтинги, достижения, о себе, тема). Только переключение показа —
   вся логика данных остаётся в app.js и social.js. */
(function () {
  const VIEWS = ["main", "modes", "ach", "edit", "theme"];

  function showProfileView(name) {
    if (!VIEWS.includes(name)) name = "main";
    document.querySelectorAll("#page-profile .pview").forEach((v) => {
      v.hidden = v.dataset.pview !== name;
    });
    window.scrollTo(0, 0);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const page = document.getElementById("page-profile");
    if (!page) return;
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
