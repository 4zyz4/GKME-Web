// GKME-Web — application controller.
//
// Wires the connection, layout engine, input aggregation, haptics and the
// settings UI together, mirroring the Android GkViewModel + MainActivity roles.

import { Connection, getDeviceName, setDeviceName } from "./protocol.js";
import { GamepadLayout, DEFAULT_APPEARANCE, normalizeButton } from "./layout.js";
import { BIT, DPAD, Kb, KB_MODIFIER_CODES, MODIFIER_BITS, CONTROLS, getControl, DISPLAY_MODES, defaultSizeFor } from "./controls.js";
import {
  loadSettings, saveSettings, ensurePresets, savePresets, getActivePresetName,
  setActivePresetName, InputState, DEFAULT_SETTINGS,
} from "./state.js";
import { Haptics } from "./haptics.js";
import { PAGES } from "./settings-pages.js";
import { FULL_CON } from "./presets.js";
import { LayoutEditor } from "./editor.js";
import { showConfirm, showInput } from "./dialog.js";

const APP_VERSION = "1.0.0";

class App {
  constructor() {
    this.settings = loadSettings();
    // The web build has no appearance editor; always use the Android default profile.
    this.settings.appearance = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
    this.presets = ensurePresets();
    this.activePreset = getActivePresetName();
    if (!this.presets[this.activePreset]) this.activePreset = "full_con";
    this.conn = new Connection();
    this.state = new InputState();
    this.haptics = new Haptics(this.settings);

    this.kbKeys = new Set();
    this.kbModifiers = 0;
    this.shiftActive = false;

    this.physicalButtons = 0;
    this.physicalEnabled = false;

    this._raf = null;
    this._sendTimer = null;
    this._wakeLock = null;
    this._lastInputJson = "";

    this._bindDom();
    this._bindConnection();
    this._buildLayout();
    this._buildSettings();
    this.editor = new LayoutEditor(this);
    this._startLoops();
    // First connection is manual: wait for the user to tap 连接.
    this._updateStatus("disconnected");
    if (this.settings.screen.keepAwake) this._acquireWakeLock();
  }

  // ── DOM ──
  _bindDom() {
    this.topbar = document.getElementById("topbar");
    this.statusText = document.getElementById("statusText");
    this.connectOverlay = document.getElementById("connectOverlay");
    this.connectMsg = document.getElementById("connectMsg");
    this.connectBtn = document.getElementById("connectBtn");
    this.canvas = document.getElementById("gamepad");
    this.settingsPanel = document.getElementById("settings");
    this.settingsBody = document.getElementById("settingsBody");
    this.settingsNav = document.getElementById("settingsNav");
    this.settingsNavList = document.getElementById("settingsNavList");
    this.settingsClose = document.getElementById("settingsClose");
    this.toast = document.getElementById("toast");

    this.settingsClose.addEventListener("click", () => this.closeSettings());
    window.addEventListener("gamepadconnected", () => this._onGamepadsChanged());
    window.addEventListener("gamepaddisconnected", () => this._onGamepadsChanged());
    window.addEventListener("resize", () => {
      this.layout && this.layout.resize();
      this._positionStatus();
    });
    window.addEventListener("orientationchange", () => setTimeout(() => { this.layout.resize(); this._positionStatus(); }, 300));
    document.addEventListener("fullscreenchange", () => setTimeout(() => { this.layout.resize(); this._positionStatus(); }, 300));

    this.connectBtn.addEventListener("click", () => {
      this.conn.connect();
      this._enterFullscreen();
    });
  }

  _toast(msg, ms = 2200) {
    this.toast.textContent = msg;
    this.toast.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove("show"), ms);
  }

  _enterFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  }

  async _acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      this._wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }

  async _releaseWakeLock() {
    try { await this._wakeLock?.release(); } catch {}
    this._wakeLock = null;
  }

  // ── Layout ──
  _buildLayout() {
    this.layout = new GamepadLayout(this.canvas, {
      onOpenSettings: () => this.openSettings(),
      onButtonDown: (id, bit) => {
        this.state._touchButtons = (this.state._touchButtons | bit) >>> 0;
        // Send the press before any (possibly blocking) haptic call so the
        // host sees it without waiting for the next timer tick.
        this._sendFrame();
        this.haptics.buttonPulse(true);
      },
      onButtonUp: (id, bit) => {
        this.state._touchButtons = (this.state._touchButtons & ~bit) >>> 0;
        this._sendFrame();
        this.haptics.buttonPulse(false);
      },
      onStick: (axis, x, y) => {
        if (axis === "left") { this.state.leftStickX = x; this.state.leftStickY = y; }
        else { this.state.rightStickX = x; this.state.rightStickY = y; }
      },
      onDpad: (hat) => {
        this.state._touchDpad = hat >>> 0;
        this._sendFrame();
        const pressed = (hat >>> 0) !== 0;
        if (pressed !== this._dpadPressed) {
          this._dpadPressed = pressed;
          this.haptics.buttonPulse(pressed);
        }
      },
      onTrigger: (which, value) => {
        if (which === "left") this.state.leftTrigger = value;
        else this.state.rightTrigger = value;
      },
      onTouchpad: (touches) => {
        this.state.touches = touches;
      },
      onMouseMove: (dx, dy, b) => {
        const acc = b.mouseSensitivity || 1;
        this.state.mouseDx += Math.round(dx * acc);
        this.state.mouseDy += Math.round(dy * acc);
      },
      onMouseTap: (b) => {
        this._mouseClick(BIT.MOUSE_LMB);
      },
      onCustomBits: (bits, down) => this._applyCustomBits(bits, down),
      onKey: (code, down) => this._onKey(code, down),
      onEditChanged: () => this.editor && this.editor.onEditChanged(),
      onEditEnd: () => this.editor && this.editor.onEditEnd(),
      onSelect: (id) => this.editor && this.editor.onSelect(id),
    });
    this.layout.setDisplayMode(this.settings.displayMode);
    this.layout.keyboardShift = false;
    this.layout.setPreset(this.presets[this.activePreset]);
    this._positionStatus();

    this._applyAppearanceToLayout();
  }

  _loadPreset(name) {
    if (!this.presets[name]) return;
    this.activePreset = name;
    setActivePresetName(name);
    this.layout.setPreset(this.presets[name]);
    this._positionStatus();
    this._toast("已加载预设：" + name);
  }

  _saveCurrentPreset() {
    this.presets[this.activePreset] = this.layout.serialize();
    savePresets(this.presets);
    this._toast("已保存预设：" + this.activePreset);
  }

  _applyCustomBits(bits, down) {
    const hasBits = !!(bits && bits.length);
    for (const bit of bits || []) {
      if (down) {
        this.state._customBits = (this.state._customBits | bit) >>> 0;
      } else {
        this.state._customBits = (this.state._customBits & ~bit) >>> 0;
      }
    }
    this._sendFrame();
    // Custom buttons / custom keypad emit through this path instead of
    // onButtonDown/Up, so fire the button pulse here too (skip empty mappings
    // to avoid double pulses when sliding across an unconfigured keypad).
    if (hasBits) this.haptics.buttonPulse(down);
  }

  _mouseClick(bit) {
    if (this.state._mouseTouch & bit) return;
    this.state._mouseTouch = (this.state._mouseTouch | bit) >>> 0;
    clearTimeout(this._mouseClicks && this._mouseClicks[bit]);
    this._mouseClicks = this._mouseClicks || {};
    this._mouseClicks[bit] = setTimeout(() => {
      this.state._mouseTouch = (this.state._mouseTouch & ~bit) >>> 0;
    }, 60);
  }

  _onKey(code, down) {
    if (KB_MODIFIER_CODES.has(code)) {
      const mbit = this._modifierBitFor(code);
      if (down) {
        this.kbModifiers |= mbit;
      } else {
        this.kbModifiers &= ~mbit;
      }
    } else if (down) {
      this.kbKeys.add(code);
    } else {
      this.kbKeys.delete(code);
    }
    this._sendFrame();
    // Shift affects keyboard labels.
    const shift = code === Kb.LShift || code === Kb.RShift;
    if (shift) {
      this.shiftActive = down;
      this.layout.setKeyboardShift(down);
    }
    this.haptics.buttonPulse(down);
  }

  _modifierBitFor(code) {
    switch (code) {
      case Kb.LCtrl: return MODIFIER_BITS.LCtrl;
      case Kb.LShift: return MODIFIER_BITS.LShift;
      case Kb.LAlt: return MODIFIER_BITS.LAlt;
      case Kb.LGui: return MODIFIER_BITS.LGui;
      case Kb.RCtrl: return MODIFIER_BITS.RCtrl;
      case Kb.RShift: return MODIFIER_BITS.RShift;
      case Kb.RAlt: return MODIFIER_BITS.RAlt;
      case Kb.RGui: return MODIFIER_BITS.RGui;
      default: return 0;
    }
  }

  // ── Connection ──
  _bindConnection() {
    this.conn.addEventListener("status", (e) => this._updateStatus(e.detail.state));
    this.conn.addEventListener("vibration", (e) => {
      this.haptics.rumble(e.detail.largeMotor, e.detail.smallMotor);
    });
    this.conn.addEventListener("led", (e) => {
      this._onLed(e.detail);
    });
    this.conn.addEventListener("serverDisconnect", (e) => {
      this._toast("主机断开连接" + (e.detail ? "：" + e.detail : ""));
    });
  }

  _updateStatus(state) {
    const map = {
      connecting: "连接中…",
      connected: "已连接",
      disconnected: "未连接",
    };
    this.statusText.textContent = map[state] || map.disconnected;
    this.connectOverlay.classList.toggle("hidden", state === "connected");
    if (state === "connected" && this.settings.screen.keepAwake) this._acquireWakeLock();
    this._positionStatus();
  }

  /** Keep the status label centred on the touchpad, matching where the
   *  device actually is on screen (and out of the settings overlay). */
  _positionStatus() {
    if (!this.layout || !this.topbar) return;
    const tp = this.layout.buttons.find((b) => b.isTouchpad || b.isMousepad);
    // Mirrors Android: the status label is a child of the touchpad/mousepad
    // view, so it is only shown when such a control exists in the layout.
    this.topbar.classList.toggle("no-touchpad", !tp);
    let left;
    let top;
    if (tp) {
      const r = this.layout.gridRect(tp);
      left = r.x + r.w / 2;
      top = r.y + r.h / 2;
    } else {
      left = this.layout.cssW / 2;
      top = this.layout.cssH * 0.28;
    }
    this.topbar.style.left = left + "px";
    this.topbar.style.top = top + "px";
  }

  _onLed(led) {
    this._ledColor = led.color;
    // Optional LED-bound appearance could be applied here.
  }

  // ── Loops ──
  _startLoops() {
    const loop = () => {
      this._pollPhysicalGamepad();
      this.layout.setPressedBits(this.state.buttons);
      this.layout.render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);

    this._restartSendLoop();
  }

  _restartSendLoop() {
    if (this._sendTimer) clearInterval(this._sendTimer);
    const hz = Math.max(10, Math.min(1000, this.settings.pollingHz || 125));
    const interval = Math.round(1000 / hz);
    this._sendTimer = setInterval(() => this._sendFrame(), interval);
  }

  _sendFrame() {
    if (!this.conn.connected) return;
    const st = this.state;
    // Fold keyboard state into the snapshot.
    st.kbKeys = this.kbKeys;
    st.kbModifiers = this.kbModifiers;
    const input = st.toInput();
    this.conn.sendGamepadInput(input);
    // Mouse deltas are consumed each frame.
    st.mouseDx = 0;
    st.mouseDy = 0;
    st.mouseWheel = 0;
    st.mousePan = 0;
  }

  // ── Physical controller forwarding (Gamepad API) ──
  _pollPhysicalGamepad() {
    if (!navigator.getGamepads) return;
    if (!this.settings.physical.forward) {
      this.state._physicalButtons = 0;
      this.state._physicalDpad = 0;
      return;
    }
    const pads = navigator.getGamepads();
    let buttons = 0;
    let lx = 0, ly = 0, rx = 0, ry = 0, lt = 0, rt = 0, dpad = 0;
    let any = false;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      any = true;
      const b = (i) => p.buttons[i] && p.buttons[i].pressed;
      const v = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      if (b(0)) buttons |= BIT.A;
      if (b(1)) buttons |= BIT.B;
      if (b(2)) buttons |= BIT.X;
      if (b(3)) buttons |= BIT.Y;
      if (b(4)) buttons |= BIT.LB;
      if (b(5)) buttons |= BIT.RB;
      if (b(8)) buttons |= BIT.SELECT;
      if (b(9)) buttons |= BIT.START;
      if (b(10)) buttons |= BIT.L3;
      if (b(11)) buttons |= BIT.R3;
      if (b(16)) buttons |= BIT.HOME;
      if (b(12)) dpad |= DPAD.UP;
      if (b(13)) dpad |= DPAD.DOWN;
      if (b(14)) dpad |= DPAD.LEFT;
      if (b(15)) dpad |= DPAD.RIGHT;
      if (v(6) > 0.02) lt = Math.max(lt, Math.round(v(6) * 255));
      if (v(7) > 0.02) rt = Math.max(rt, Math.round(v(7) * 255));
      lx = p.axes[0] || 0;
      ly = p.axes[1] || 0;
      rx = p.axes[2] || 0;
      ry = p.axes[3] || 0;
      if (dpad & (DPAD.UP | DPAD.DOWN)) buttons |= 0;
    }
    this.physicalPresent = any;
    this.state._physicalButtons = buttons >>> 0;
    this.state._physicalDpad = dpad >>> 0;
    if (any) {
      // Physical sticks only override the virtual ones when the touch stick is idle.
      if (!this.layout.controlActive.get("leftJoystick")) {
        this.state.leftStickX = Math.round(lx * 32767);
        this.state.leftStickY = Math.round(ly * 32767);
      }
      if (!this.layout.controlActive.get("rightJoystick")) {
        this.state.rightStickX = Math.round(rx * 32767);
        this.state.rightStickY = Math.round(ry * 32767);
      }
      if (!this.layout.controlActive.get("btnLT")) this.state.leftTrigger = lt;
      if (!this.layout.controlActive.get("btnRT")) this.state.rightTrigger = rt;
    }
  }

  // ── Settings UI ──
  openSettings() {
    this.settingsPanel.classList.remove("hidden");
    this.topbar.classList.add("hidden");
    this.toast.classList.remove("show");
    this._renderSettingsNav();
    this._selectCategory(this._category || "connection");
  }

  closeSettings() {
    this.settingsPanel.classList.add("hidden");
    this.topbar.classList.remove("hidden");
    this._positionStatus();
    // Persist whatever was edited.
    saveSettings(this.settings);
    this.presets[this.activePreset] = this.layout.serialize();
    savePresets(this.presets);
  }

  _renderSettingsNav() {
    const cats = [
      ["connection", "连接"],
      ["presets", "布局"],
      ["physical", "实体手柄"],
      ["vibration", "震动"],
      ["misc", "杂项"],
      ["about", "关于"],
    ];
    const list = this.settingsNavList || this.settingsNav;
    list.innerHTML = "";
    for (const [id, label] of cats) {
      const b = document.createElement("button");
      b.className = "navitem";
      b.dataset.cat = id;
      b.textContent = label;
      b.addEventListener("click", () => this._selectCategory(id));
      list.appendChild(b);
    }
  }

  _selectCategory(id) {
    this._category = id;
    for (const b of this.settingsNav.querySelectorAll(".navitem")) {
      b.classList.toggle("active", b.dataset.cat === id);
    }
    this.settingsBody.innerHTML = "";
    const builder = PAGES[id];
    if (builder) builder(this, this.settingsBody);
  }

  /** Rebuild pages whose device list depends on the connected gamepads. */
  _onGamepadsChanged() {
    if (this.settingsPanel.classList.contains("hidden")) return;
    if (this._category === "vibration" || this._category === "physical") {
      this._selectCategory(this._category);
    }
  }

  _buildSettings() {
    this._renderSettingsNav();
  }

  // ── Layout editing ──
  enterEditMode() {
    if (this.editor.isOpen) return;
    this.closeSettings();
    this.editor.open();
  }

  // ── Preset management (used by the 布局预设 settings page) ──
  isBuiltInPreset(name) {
    return name === "full_con";
  }

  presetNames() {
    return Object.keys(this.presets);
  }

  createDefaultPreset() {
    return { version: 1, buttons: [] };
  }

  async newPreset() {
    const nn = await showInput("新建布局", { hint: "输入新预设名称", prefill: "custom_" + (Object.keys(this.presets).length + 1) });
    if (!nn) return false;
    if (this.presets[nn]) { this._toast("预设已存在"); return false; }
    this.presets[nn] = this.createDefaultPreset();
    savePresets(this.presets);
    this._loadPreset(nn);
    return true;
  }

  async copyCurrentPreset() {
    const src = this.activePreset;
    const nn = await showInput("复制布局", { hint: "输入新预设名称", prefill: "复制_" + src.replace(/^复制_/, "") });
    if (!nn) return false;
    if (this.presets[nn]) { this._toast("预设已存在"); return false; }
    this.presets[nn] = JSON.parse(JSON.stringify(this.presets[src]));
    savePresets(this.presets);
    this._loadPreset(nn);
    return true;
  }

  async renameCurrentPreset() {
    const src = this.activePreset;
    if (this.isBuiltInPreset(src)) { this._toast("内置布局禁止重命名"); return false; }
    const nn = await showInput("重命名", { prefill: src });
    if (!nn || nn === src) return false;
    if (this.presets[nn]) { this._toast("名称已存在"); return false; }
    this.presets[nn] = this.presets[src];
    delete this.presets[src];
    this.activePreset = nn;
    setActivePresetName(nn);
    savePresets(this.presets);
    return true;
  }

  async deleteCurrentPreset() {
    const src = this.activePreset;
    if (this.isBuiltInPreset(src)) { this._toast("内置布局禁止删除"); return false; }
    if (!(await showConfirm("删除预设", "确定删除「" + src + "」？", { positiveText: "删除" }))) return false;
    delete this.presets[src];
    savePresets(this.presets);
    const rest = Object.keys(this.presets);
    this._loadPreset(rest.length ? rest[0] : "full_con");
    return true;
  }

  async restoreCurrentDefault() {
    const src = this.activePreset;
    if (!this.isBuiltInPreset(src)) return false;
    if (!(await showConfirm("恢复默认", "确定将内置布局「" + src + "」恢复为默认？", { positiveText: "恢复默认" }))) return false;
    this.presets[src] = JSON.parse(JSON.stringify(FULL_CON));
    savePresets(this.presets);
    this._loadPreset(src);
    this._toast("已恢复「" + src + "」为默认");
    return true;
  }

  exportCurrentPreset() {
    this._exportJson(this.activePreset + ".json", this.presets[this.activePreset]);
  }

  async importPresetFromFile(file) {
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const nn = await showInput("导入布局", { hint: "输入预设名称", prefill: file.name.replace(/\.json$/, "") });
      if (!nn) return false;
      this.presets[nn] = obj;
      savePresets(this.presets);
      this._loadPreset(nn);
      return true;
    } catch {
      this._toast("导入失败：无效 JSON");
      return false;
    }
  }

  _exportJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  _showAddControl() {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const box = document.createElement("div");
    box.className = "modalbox";
    box.appendChild(Object.assign(document.createElement("div"), { className: "modaltitle", textContent: "添加控件" }));
    const grid = document.createElement("div");
    grid.className = "modalgrid";
    for (const [id, meta] of Object.entries(CONTROLS)) {
      if (id === "btnSettings") continue;
      // Keyboard and mouse controls are not part of the web build.
      if (meta.isKeyboard) continue;
      if (id === "mousepad" || id.startsWith("btnMouse")) continue;
      const b = document.createElement("button");
      b.textContent = meta.name;
      b.addEventListener("click", () => {
        this._addControl(id);
        overlay.remove();
      });
      grid.appendChild(b);
    }
    box.appendChild(grid);
    const close = document.createElement("button");
    close.className = "modalclose";
    close.textContent = "关闭";
    close.addEventListener("click", () => overlay.remove());
    box.appendChild(close);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  async _addControl(baseId) {
    const [w, h] = defaultSizeFor(baseId);
    let id = baseId;
    let n = 1;
    while (this.layout.buttons.some((b) => b.id === id)) id = baseId + "_" + n++;
    const spot = this._findFreeSpot(w, h);
    const raw = { id, x: spot.x, y: spot.y, w, h };
    if (baseId === "btnCustomRect" || baseId === "btnCustomCircle") {
      raw.isCustom = true;
      raw.customText = (await showInput("自定义按钮文字", { hint: "输入按钮文字", prefill: "自定义" })) || "自定义";
      raw.customBits = [];
    }
    if (baseId === "customKeypad") {
      raw.isKeypad = true;
      raw.keypadTexts = ["上", "下", "左", "右", "中", "左上", "右上", "左下", "右下"];
      raw.keypadBits = [[], [], [], [], [], [], [], [], []];
    }
    const b = normalizeButton(raw);
    this.layout.buttons.push(b);
    this.layout.selectedId = b.id;
    this.layout.render();
    this._positionStatus();
    this.editor.onSelect(b.id);
  }

  _findFreeSpot(w, h) {
    const occupied = (x, y) =>
      this.layout.buttons.some((b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
    for (let y = 2; y < 50; y += 2) {
      for (let x = 2; x < 120 - w; x += 2) {
        if (!occupied(x, y)) return { x, y };
      }
    }
    return { x: 40, y: 20 };
  }

  _applyAppearanceToLayout() {
    this.layout.setAppearance(this.settings.appearance || JSON.parse(JSON.stringify(DEFAULT_APPEARANCE)));
  }
}

// ── tiny DOM helper used by page builders ──

window.addEventListener("DOMContentLoaded", () => {
  window.gkme = new App();
});
