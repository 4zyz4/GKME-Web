// GKME-Web — settings page builders (mirrors the 9 Android settings pages).

import { el, row, section, toggle, slider, select, button, colorInput } from "./dom.js";
import { DISPLAY_MODES } from "./controls.js";
import { DEFAULT_APPEARANCE } from "./layout.js";
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
    const list = el("div", { class: "presetlist" });
    const rebuild = () => {
      list.innerHTML = "";
      for (const name of Object.keys(app.presets)) {
        const isActive = name === app.activePreset;
        list.appendChild(
          el("div", { class: "presetitem" + (isActive ? " active" : "") }, [
            el("span", { class: "presetname", text: name }),
            el("div", { class: "presetbtns" }, [
              button("加载", () => {
                app._loadPreset(name);
                app._selectCategory("presets");
              }),
              button("重命名", () => {
                const nn = prompt("新名称", name);
                if (!nn || nn === name || app.presets[nn]) return;
                app.presets[nn] = app.presets[name];
                delete app.presets[name];
                if (app.activePreset === name) {
                  app.activePreset = nn;
                  app._loadPreset(nn);
                }
                save(app);
                rebuild();
              }),
              button(
                "复制",
                () => {
                  let nn = name + "_copy";
                  let i = 1;
                  while (app.presets[nn]) nn = name + "_copy" + i++;
                  app.presets[nn] = JSON.parse(JSON.stringify(app.presets[name]));
                  save(app);
                  rebuild();
                },
                "ghost"
              ),
              button(
                "删除",
                () => {
                  if (name === "full_con") {
                    app._toast("内置预设不可删除");
                    return;
                  }
                  if (!confirm("删除预设 " + name + "?")) return;
                  delete app.presets[name];
                  save(app);
                  rebuild();
                },
                "danger"
              ),
            ]),
          ])
        );
      }
    };
    rebuild();

    root.appendChild(section("预设列表", [list]));
    root.appendChild(
      section("操作", [
        el("div", { class: "btnrow" }, [
          button("新建（当前布局）", () => {
            const nn = prompt("新预设名称", "custom_" + (Object.keys(app.presets).length + 1));
            if (!nn || app.presets[nn]) return;
            app.presets[nn] = app.layout.serialize();
            save(app);
            rebuild();
          }),
          button("进入编辑模式", () => {
            app.closeSettings();
            app._toggleEdit(true);
          }),
          button("导出当前预设", () => exportJson(app.activePreset + ".json", app.layout.serialize())),
        ]),
        el(
          "label",
          { class: "filebtn" },
          [
            "导入预设…",
            el("input", {
              type: "file",
              accept: ".json,application/json",
              onchange: async (e) => {
                const f = e.target.files[0];
                if (!f) return;
                try {
                  const obj = JSON.parse(await f.text());
                  const nn = prompt("保存为预设名称", f.name.replace(/\.json$/, ""));
                  if (!nn) return;
                  app.presets[nn] = obj;
                  save(app);
                  rebuild();
                } catch {
                  app._toast("导入失败：无效 JSON");
                }
              },
            }),
          ]
        ),
      ])
    );
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

  gyro(app, root) {
    const status = el("span", { class: "statusval", text: gyroStatus(app) });
    root.appendChild(
      section("手柄原生陀螺仪", [
        row("状态", status),
        el("div", { class: "btnrow" }, [
          button("启用体感", async () => {
            const ok = await app.gyro.start();
            status.textContent = gyroStatus(app);
            app._toast(ok ? "体感已启用" : "体感启用失败（需要 HTTPS 与用户授权）");
          }),
          button("停止", () => {
            app.gyro.stop();
            status.textContent = gyroStatus(app);
          }, "ghost"),
        ]),
      ])
    );
    root.appendChild(
      el("p", { class: "hint", text: "陀螺仪与加速度计数据将直接作为手柄原生陀螺仪上报给电脑端，不在网页端做鼠标/摇杆映射。需要安全上下文（HTTPS 或 localhost），iOS 还需在用户手势中授权。" })
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
        el("p", { text: "本网页版把浏览器变成虚拟手柄控制器：触摸布局、键盘、鼠标、体感与振动。电脑端由 GKME-Windows 托管页面并创建虚拟手柄。" }),
        el("p", { text: "开源协议：GPLv3。" }),
      ])
    );
  },
};

function save(app) {
  savePresets(app.presets);
}

function exportJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function gyroStatus(app) {
  if (!app.gyro.supported) return "不支持";
  if (app.gyro.enabled) return "运行中";
  return "未启用";
}

function setDeviceNameSafe(name) {
  try {
    localStorage.setItem("gkme.deviceName", name || "");
  } catch {}
}
