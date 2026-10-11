// GKME-Web — custom dialogs mirroring android CustomDialog.kt.
//
// Replaces the browser-native confirm()/prompt() so dialogs match the Android
// look: #1E1E1E surface, centered bold title, dim message, right-aligned
// cancel/confirm buttons (#333 / #666). Web APIs are promise-based instead of
// blocking, so callers use `await`.

import { el } from "./dom.js";

function openDialog() {
  const overlay = el("div", { class: "dlgov" });
  const box = el("div", { class: "dlgbox" });
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { overlay, box, close: () => overlay.remove() };
}

function btnRow(negativeText, positiveText, onNegative, onPositive) {
  const row = el("div", { class: "dlgbtnrow" });
  if (negativeText) {
    const neg = el("button", { type: "button", class: "dlgbtn", text: negativeText });
    neg.addEventListener("click", onNegative);
    row.appendChild(neg);
  }
  if (positiveText) {
    const pos = el("button", { type: "button", class: "dlgbtn primary", text: positiveText });
    pos.addEventListener("click", onPositive);
    row.appendChild(pos);
  }
  return row;
}

/** Android CustomDialog.showConfirm — resolves true on confirm, false otherwise. */
export function showConfirm(title, message, opts = {}) {
  const { positiveText = "确定", negativeText = "取消" } = opts;
  return new Promise((resolve) => {
    const { overlay, box, close } = openDialog();
    box.appendChild(el("div", { class: "dlgtitle", text: title }));
    if (message) box.appendChild(el("div", { class: "dlgmsg", text: message }));
    box.appendChild(btnRow(
      negativeText, positiveText,
      () => { close(); resolve(false); },
      () => { close(); resolve(true); },
    ));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { close(); resolve(false); } });
  });
}

/** Android CustomDialog.showInput — resolves the trimmed string, or null on cancel. */
export function showInput(title, opts = {}) {
  const { hint = "", prefill = "", positiveText = "确定", negativeText = "取消" } = opts;
  return new Promise((resolve) => {
    const { overlay, box, close } = openDialog();
    box.appendChild(el("div", { class: "dlgtitle", text: title }));
    const input = el("input", { class: "dlginput", type: "text", placeholder: hint });
    input.value = prefill;
    box.appendChild(input);
    const cancel = () => { close(); resolve(null); };
    const submit = () => { close(); resolve(input.value.trim() || null); };
    box.appendChild(btnRow(negativeText, positiveText, cancel, submit));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cancel(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
