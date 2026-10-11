// GKME-Web — settings page builders (mirrors the 9 Android settings pages).

import { el, row, section, toggle, slider, select, button, colorInput } from "./dom.js";
import { DISPLAY_MODES } from "./controls.js";
import { DEFAULT_APPEARANCE, normalizeButton } from "./layout.js";
import { DEFAULT_SETTINGS, savePresets } from "./state.js";

function ensureAppearance(app) {
  if (!app.settings.appearance) {
    app.settings.appearance = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
  }
  return app.settings.appearance;
}

function applyAppearance(app) {
  app.layout.setAppearance(ensureAppearance(app));
}

const POLL_RATES = [30, 45, 60, 90, 100, 120, 200, 250, 300, 500, 750, 1000];

export const PAGES = {
  connection(app, root) {
    root.appendChild(
      section("连接状态", [
        row("状态", el("span", { text: app.conn.connected ? "已连接" : "未连接", class: "statusval" })),
        row("主机", el("span", { text: app.conn.hostName || "-", class: "statusval" })),
        row("协议版本", el("span", { text: String(app.conn.protocolVersion || "-"), class: "statusval" })),
        row("设备 ID", el("span", { text: app.conn.deviceId, class: "statusval small" })),
      ])
    );

    const nameInput = el("input", { type: "text", value: app.settings.meta.deviceName || "" });
    nameInput.addEventListener("change", () => {
      app.settings.meta.deviceName = nameInput.value;
      setDeviceNameSafe(nameInput.value);
      app.conn.disconnect();
      app.conn.connect();
    });

    root.appendChild(
      section("设备", [
        row("设备名称", nameInput),
        row(
          "轮询率",
          select(
            POLL_RATES.map((r) => [r, r + " Hz"]),
            String(app.settings.pollingHz),
            (v) => {
              app.settings.pollingHz = Number(v);
              app._restartSendLoop();
            }
          )
        ),
      ])
    );

    root.appendChild(
      section("操作", [
        el("div", { class: "btnrow" }, [
          button("重新连接", () => {
            app.conn.disconnect();
            app.conn.connect();
          }),
          button("进入全屏", () => app._enterFullscreen()),
        ]),
        el("p", { class: "hint", text: "网页版仅使用 WebSocket 连接（等价于原 App 的 WiFi 模式）。蓝牙 HID、USB/ADB、本机(Shizuku)、被控端(uinput)模式在浏览器中不可用。" }),
      ])
    );
  },

  presets(app, root) {
    const build = () => {
      root.innerHTML = "";
      root.appendChild(el("div", { class: "presettitle", text: "布局预设" }));

      const current = app.activePreset;
      const isBuiltIn = app.isBuiltInPreset(current);

      const chips = el("div", { class: "presetchips" });
      const chip = (label, fn) => {
        const b = button(label, fn);
        b.classList.add("presetchip");
        chips.appendChild(b);
        return b;
      };
      chip("新建", () => { if (app.newPreset()) build(); });
      chip("编辑", () => app.enterEditMode());
      if (isBuiltIn) chip("恢复默认", () => { if (app.restoreCurrentDefault()) build(); });
      chip("复制", () => { if (app.copyCurrentPreset()) build(); });
      chip("导出", () => app.exportCurrentPreset());
      chips.appendChild(
        el("label", { class: "filebtn presetchip" }, [
          "导入",
          el("input", {
            type: "file",
            accept: ".json,application/json",
            onchange: async (e) => {
              const f = e.target.files[0];
              if (!f) return;
              if (await app.importPresetFromFile(f)) build();
              e.target.value = "";
            },
          }),
        ])
      );
      if (!isBuiltIn) {
        chip("重命名", () => { if (app.renameCurrentPreset()) build(); });
        chip("删除", () => { if (app.deleteCurrentPreset()) build(); });
      }
      root.appendChild(chips);

      root.appendChild(el("div", { class: "presetcurrent", text: "当前预设: " + current }));

      const grid = el("div", { class: "presetgrid" });
      for (const name of app.presetNames()) {
        const active = name === app.activePreset;
        const canvas = el("canvas", { class: "presetpreview" });
        const card = el("div", { class: "presetcard" + (active ? " active" : "") }, [
          canvas,
          el("div", { class: "presetcardname", text: name }),
        ]);
        card.addEventListener("click", () => {
          if (name === app.activePreset) return;
          app._loadPreset(name);
          build();
        });
        grid.appendChild(card);
        requestAnimationFrame(() => drawPresetPreview(canvas, app.presets[name]));
      }
      root.appendChild(grid);
    };
    build();
  },

  physical(app, root) {
    const pads = [];
    if (navigator.getGamepads) {
      for (const p of navigator.getGamepads()) if (p && p.connected) pads.push(p);
    }
    root.appendChild(
      section("实体手柄（Gamepad API）", [
        row("转发实体手柄", toggle(app.settings.physical.forward, (v) => (app.settings.physical.forward = v))),
        row("已连接手柄", el("span", { class: "statusval", text: String(pads.length) })),
      ])
    );
    const listEl = el("div", { class: "padlist" });
    if (pads.length === 0) {
      listEl.appendChild(el("p", { class: "hint", text: "未检测到实体手柄。通过蓝牙/OTG 连接手柄后，在浏览器中按一次手柄按键即可被识别。" }));
    } else {
      for (const p of pads) {
        listEl.appendChild(el("div", { class: "padsrow", text: `${p.index}: ${p.id} (${p.mapping}) — ${p.buttons.length} 键 / ${p.axes.length} 轴` }));
      }
    }
    root.appendChild(section("设备列表", [listEl]));
    root.appendChild(
      el("p", { class: "hint", text: "浏览器只能读取标准映射手柄的按键/摇杆/扳机，无法透传自适应扳机、触摸板、HD 震动等厂商特性。" })
    );
  },

  vibration(app, root) {
    root.appendChild(
      section("按钮震动", [
        row("按键按下震动", toggle(app.settings.haptics.buttonVibrate, (v) => (app.settings.haptics.buttonVibrate = v))),
        row("震动时长", slider(5, 60, 1, app.settings.haptics.buttonVibrateMs, (v) => (app.settings.haptics.buttonVibrateMs = v), (v) => v + " ms")),
      ])
    );
    root.appendChild(
      section("游戏震动", [
        row("接收主机震动", toggle(app.settings.haptics.gameVibrate, (v) => (app.settings.haptics.gameVibrate = v))),
        row("交换左右马达", toggle(app.settings.haptics.swapMotors, (v) => (app.settings.haptics.swapMotors = v))),
        button("测试震动", () => app.haptics.rumble(255, 255)),
      ])
    );
    root.appendChild(
      el("p", { class: "hint", text: app.haptics.supported ? "使用浏览器 Vibration API（仅移动端浏览器支持）。" : "当前浏览器不支持 Vibration API。" })
    );
  },

  misc(app, root) {
    root.appendChild(
      section("显示", [
        row(
          "按键样式",
          select(
            DISPLAY_MODES.map((m) => [m, m]),
            app.settings.displayMode,
            (v) => {
              app.settings.displayMode = v;
              app.layout.setDisplayMode(v);
            }
          )
        ),
        row("保持屏幕常亮", toggle(app.settings.screen.keepAwake, (v) => {
          app.settings.screen.keepAwake = v;
          if (v) app._acquireWakeLock();
          else app._releaseWakeLock();
        })),
        row("显示网格(编辑)", toggle(false, (v) => { app.layout.showGrid = v; app.layout.render(); })),
      ])
    );
    root.appendChild(
      section("息屏模式（近似）", [
        button("进入息屏模式", () => {
          app.closeSettings();
          let overlay = document.getElementById("screenOff");
          if (!overlay) {
            overlay = el("div", { id: "screenOff", class: "screenoff" });
            overlay.addEventListener("click", () => overlay.remove());
            document.body.appendChild(overlay);
          }
          app._acquireWakeLock();
        }),
      ])
    );
    root.appendChild(
      section("重置", [
        el("div", { class: "btnrow" }, [
          button("重置全部设置", () => {
            if (!confirm("恢复默认设置？")) return;
            app.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            applyAppearance(app);
            app.layout.setDisplayMode(app.settings.displayMode);
            app._restartSendLoop();
            app._selectCategory("misc");
          }, "danger"),
          button("重置当前预设", () => {
            if (!confirm("恢复当前预设为默认？")) return;
            app.presets[app.activePreset] = { version: 1, buttons: [] };
            save(app);
            app.layout.setPreset(app.presets[app.activePreset]);
          }, "danger"),
        ]),
      ])
    );
  },

  about(app, root) {
    root.appendChild(
      section("关于 GKME-Web", [
        row("版本", el("span", { class: "statusval", text: "1.0.0" })),
        row("协议", el("span", { class: "statusval", text: "protobuf over WebSocket (v1)" })),
      ])
    );
    root.appendChild(
      el("div", { class: "abouttext" }, [
        el("p", { text: "GKME — Gamepad Keyboard Mouse Emulator / General Key Mapping Engine。" }),
        el("p", { text: "本网页版把浏览器变成虚拟手柄控制器：触摸布局、键盘、鼠标与振动。电脑端由 GKME-Windows 托管页面并创建虚拟手柄。" }),
        el("p", { text: "开源协议：GPLv3。" }),
      ])
    );
  },
};

function save(app) {
  savePresets(app.presets);
}

// Miniature layout preview for a preset card (mirrors PresetPreviewView).
function drawPresetPreview(canvas, preset) {
  const raw = (preset && preset.buttons) || [];
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!raw.length) return;

  const gridW = 120;
  const gridH = 53;
  const scale = Math.min(cssW / gridW, cssH / gridH);
  const offX = (cssW - gridW * scale) / 2;
  const offY = (cssH - gridH * scale) / 2;

  for (const r of raw) {
    const b = normalizeButton(r);
    if (b.visible === false) continue;
    const base = b.id.split("_")[0];
    const bx = offX + b.x * scale;
    const by = offY + b.y * scale;
    const swapped = !b.lockAspect && (b.rotation === 90 || b.rotation === 270);
    const bw = (swapped ? b.h : b.w) * scale;
    const bh = (swapped ? b.w : b.h) * scale;
    if (base === "dpadPad" || base === "customKeypad") {
      const s = Math.min(bw, bh);
      ctx.beginPath();
      ctx.fillStyle = "#BBBBBB";
      ctx.arc(bx + bw / 2, by + bh / 2, s / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (b.lockAspect) {
      const r2 = Math.max(2, Math.min(b.w, b.h) * scale * 0.35);
      ctx.beginPath();
      ctx.fillStyle = "#AAAAAA";
      ctx.arc(bx + bw / 2, by + bh / 2, r2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "#BBBBBB";
      ctx.fillRect(bx, by, bw, bh);
    }
  }
}

function setDeviceNameSafe(name) {
  try {
    localStorage.setItem("gkme.deviceName", name || "");
  } catch {}
}
