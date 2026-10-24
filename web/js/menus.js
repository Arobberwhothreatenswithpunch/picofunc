// ソフトキー (画面下の 6 個のメニューボタン) と選択ポップアップ
//
// item の種類:
//   { label, value?, onClick, disabled?, lit? }             押すと実行
//   { label, options: [{v, label}], get, set }              押すと選択肢を表示
//   { label, num: { get, set, step, unit, min, max } }      押すと数値入力を表示
//   null                                                     空き

const SLOTS = 6;

export function createSoftkeys(container, popupEl) {
  let items = [];
  let title = "";

  function closePopup() {
    popupEl.hidden = true;
    popupEl.innerHTML = "";
  }
  document.addEventListener("pointerdown", (e) => {
    if (!popupEl.hidden && !popupEl.contains(e.target) && !e.target.closest(".softkey")) closePopup();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopup(); });

  function place(btn) {
    const r = btn.getBoundingClientRect();
    if (window.innerWidth < 860) {          // スマホ: 画面下のシート
      popupEl.classList.add("sheet");
      popupEl.style.left = popupEl.style.top = popupEl.style.width = "";
      return;
    }
    popupEl.classList.remove("sheet");
    popupEl.style.width = `${Math.max(r.width, 180)}px`;
    popupEl.style.left = `${Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8)}px`;
    popupEl.hidden = false;
    const ph = popupEl.offsetHeight;
    popupEl.style.top = `${Math.max(8, r.top - ph - 6)}px`;
  }

  function openOptions(btn, it) {
    popupEl.innerHTML = `<div class="pop-title">${it.label}</div>`;
    const cur = it.get();
    for (const o of it.options()) {
      const b = document.createElement("button");
      b.className = "pop-item" + (o.v === cur ? " sel" : "");
      b.textContent = o.label;
      if (o.color) b.style.setProperty("--c", o.color);
      b.addEventListener("click", () => { it.set(o.v); closePopup(); render(); });
      popupEl.append(b);
    }
    popupEl.hidden = false;
    place(btn);
  }

  function openNum(btn, it) {
    const n = it.num;
    popupEl.innerHTML = `<div class="pop-title">${it.label}</div>
      <div class="pop-num"><button class="pop-step" data-d="-1">−</button>
      <input type="number" step="any" inputmode="decimal"><span>${n.unit || ""}</span>
      <button class="pop-step" data-d="1">＋</button></div>`;
    const inp = popupEl.querySelector("input");
    inp.value = n.get();
    const commit = (v) => {
      if (!isFinite(v)) return;
      if (n.min !== undefined) v = Math.max(v, n.min);
      if (n.max !== undefined) v = Math.min(v, n.max);
      n.set(v);
      inp.value = n.get();
      render();
    };
    inp.addEventListener("change", () => commit(parseFloat(inp.value)));
    popupEl.querySelectorAll(".pop-step").forEach((b) =>
      b.addEventListener("click", () => commit(Number((+n.get() + b.dataset.d * n.step).toPrecision(10)))));
    popupEl.hidden = false;
    place(btn);
    if (window.innerWidth >= 860) inp.focus();
  }

  function valueOf(it) {
    if (it.options) {
      const o = it.options().find((x) => x.v === it.get());
      return o ? o.short || o.label : "";
    }
    if (it.num) return `${+(+it.num.get()).toPrecision(4)}${it.num.unit || ""}`;
    return it.value ? it.value() : "";
  }

  // ボタンはメニュー切替 (set) のときだけ作る。refresh は表示を書き換えるだけ
  // (毎フレーム作り直すと、押した瞬間に要素が入れ替わってクリックが失われる)
  let btns = [];
  function build() {
    container.innerHTML = "";
    const head = document.createElement("div");
    head.className = "sk-title";
    head.textContent = title;
    container.append(head);
    btns = [];
    for (let i = 0; i < SLOTS; i++) {
      const it = items[i];
      const b = document.createElement("button");
      b.className = "softkey";
      btns.push(b);
      container.append(b);
      if (!it) { b.classList.add("empty"); b.disabled = true; continue; }
      b.innerHTML = `<span class="sk-l"></span><span class="sk-v"></span>`;
      if (it.color) b.style.setProperty("--c", it.color);
      b.addEventListener("click", () => {
        if (it.options) openOptions(b, it);
        else if (it.num) openNum(b, it);
        else { closePopup(); it.onClick(); render(); }
      });
    }
    render();
  }

  function render() {
    for (let i = 0; i < SLOTS; i++) {
      const it = items[i], b = btns[i];
      if (!it || !b) continue;
      const dis = it.disabled ? !!it.disabled() : false;
      if (b.disabled !== dis) b.disabled = dis;
      const lit = !!(it.lit && it.lit());
      if (b.classList.contains("lit") !== lit) b.classList.toggle("lit", lit);
      const l = b.firstChild, v = b.lastChild;
      if (l.textContent !== it.label) l.textContent = it.label;
      const val = valueOf(it);
      if (v.textContent !== val) v.textContent = val;
    }
  }

  return {
    set(t, list) { title = t; items = list; closePopup(); build(); },
    refresh: render,
    close: closePopup,
  };
}
