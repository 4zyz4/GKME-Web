// GKME-Web — application controller.
//
// Wires the connection, layout engine, input aggregation, haptics and the
// settings UI together, mirroring the Android GkViewModel + MainActivity roles.

import { Connection, getDeviceName, setDeviceName } from "./protocol.js";
import { GamepadLayout, DEFAULT_APPEARANCE, normalizeButton } from "./layout.js";
import { BIT, DPAD, Kb, KB_MODIFIER_CODES, MODIFIER_BITS, CONTROLS, baseId, getControl, DISPLAY_MODES, defaultSizeFor } from "./controls.js";
import {
  loadSettings, saveSettings, ensurePresets, savePresets, getActivePresetName,
  setActivePresetName, InputState, DEFAULT_SETTINGS,
} from "./state.js";
import { Haptics } from "./haptics.js";
import { PAGES } from "./settings-pages.js";

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
    this._buildEditBar();
    this._startLoops();
    // First connection is manual: wait for the user to tap 连接.
    this._updateStatus("disconnected");
    if (this.settings.screen.keepAwake) this._acquireWakeLock();
  }

  // ── DOM ──
  _bindDom() {
    this.topbar = document.getElementById("topbar");
    this.statusDot = document.getElementById("statusDot");
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
    this.editBar = document.getElementById("editbar");
    this.toast = document.getElementById("toast");

    this.settingsClose.addEventListener("click", () => this.closeSettings());
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
        this.state.holdButtons(bit);
        // Send the press before any (possibly blocking) haptic call so the
        // host sees it without waiting for the next timer tick.
        this._sendFrame();
        this.haptics.buttonPulse();
      },
      onButtonUp: (id, bit) => {
        this.state._touchButtons = (this.state._touchButtons & ~bit) >>> 0;
        this._sendFrame();
      },
      onStick: (axis, x, y) => {
        if (axis === "left") { this.state.leftStickX = x; this.state.leftStickY = y; }
        else { this.state.rightStickX = x; this.state.rightStickY = y; }
      },
      onDpad: (hat) => {
        this.state._touchDpad = hat >>> 0;
        if (hat) this.state.holdDpad(hat >>> 0);
        this._sendFrame();
      },
      onTrigger: (which, value) => {
        if (which === "left") this.state.leftTrigger = value;
        else this.state.rightTrigger = value;
        this.state.holdTrigger(which, value);
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
      onEditChanged: () => this._syncEditBar(),
      onSelect: (id) => this._syncEditBar(),
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
    for (const bit of bits || []) {
      if (down) {
        this.state._customBits = (this.state._customBits | bit) >>> 0;
        this.state.holdButtons(bit);
      } else {
        this.state._customBits = (this.state._customBits & ~bit) >>> 0;
      }
    }
    this._sendFrame();
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
        this.state.holdModifier(mbit);
      } else {
        this.kbModifiers &= ~mbit;
      }
    } else if (down) {
      this.kbKeys.add(code);
      this.state.holdKeys([code]);
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
    if (down) this.haptics.buttonPulse();
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
      connecting: ["#e0a030", "连接中…"],
      connected: ["#4caf50", "已连接"],
      disconnected: ["#e0553a", "未连接"],
    };
    const [color, text] = map[state] || map.disconnected;
    this.statusDot.style.background = color;
    this.statusText.textContent = text;
    this.connectOverlay.classList.toggle("hidden", state === "connected");
    if (state === "connected" && this.settings.screen.keepAwake) this._acquireWakeLock();
    this._positionStatus();
  }

  /** Keep the connection pill centred on the touchpad, matching where the
   *  device actually is on screen (and out of the settings overlay). */
  _positionStatus() {
    if (!this.layout || !this.topbar) return;
    const tp =
      this.layout.buttons.find((b) => b.isTouchpad) ||
      this.layout.buttons.find((b) => baseId(b.id) === "touchpad");
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
    // Keep short presses "on" for at least two send intervals so they survive
    // the round trip even at low polling rates.
    this.state.minPressMs = Math.max(60, interval * 2);
    this._sendTimer = setInterval(() => this._sendFrame(), interval);
  }

  _sendFrame() {
    if (!this.conn.connected) return;
    const st = this.state;
    // Fold keyboard state into the snapshot. Time-based holds applied inside
    // toInput() guarantee any input activated since the last send is delivered
    // as a press for long enough for the host to sample it.
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
        this.state.leftStickY = Math.round(-ly * 32767);
      }
      if (!this.layout.controlActive.get("rightJoystick")) {
        this.state.rightStickX = Math.round(rx * 32767);
        this.state.rightStickY = Math.round(-ry * 32767);
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
    // Persist whatever was edited.
    saveSettings(this.settings);
    this.presets[this.activePreset] = this.layout.serialize();
    savePresets(this.presets);
  }

  _renderSettingsNav() {
    const cats = [
      ["connection", "连接"],
      ["presets", "布局预设"],
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

  _buildSettings() {
    this._renderSettingsNav();
  }

  // ── Edit bar ──
  _buildEditBar() {
    this.editBar.innerHTML = "";
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      this.editBar.appendChild(b);
      return b;
    };
    mk("完成", () => this._toggleEdit(false));
    this.editSelInfo = document.createElement("span");
    this.editSelInfo.className = "editinfo";
    this.editBar.appendChild(this.editSelInfo);
    mk("添加控件", () => this._showAddControl());
    this.editHideBtn = mk("隐藏/显示", () => {
      const b = this.layout.getButton(this.layout.selectedId);
      if (b) { b.visible = !b.visible; this.layout.render(); }
    });
    this.editDelBtn = mk("删除", () => {
      const id = this.layout.selectedId;
      if (!id) return;
      this.layout.buttons = this.layout.buttons.filter((b) => b.id !== id);
      this.layout.selectedId = null;
      this.layout.render();
      this._syncEditBar();
    });
    mk("保存", () => this._saveCurrentPreset());
    mk("网格", () => { this.layout.showGrid = !this.layout.showGrid; this.layout.render(); });
    this._syncEditBar();
  }

  _toggleEdit(on) {
    const target = on === undefined ? !this.layout.editMode : on;
    this.layout.editMode = target;
    this.editBar.classList.toggle("show", target);
    this.layout.showGrid = target;
    if (!target) {
      this.layout.selectedId = null;
      this._saveCurrentPreset();
    }
    this.layout.render();
  }

  _syncEditBar() {
    const id = this.layout.selectedId;
    this.editSelInfo.textContent = id ? "选中: " + id : "未选中";
    this.editHideBtn.disabled = !id;
    this.editDelBtn.disabled = !id;
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

  _addControl(baseId) {
    const [w, h] = defaultSizeFor(baseId);
    let id = baseId;
    let n = 1;
    while (this.layout.buttons.some((b) => b.id === id)) id = baseId + "_" + n++;
    const spot = this._findFreeSpot(w, h);
    const raw = { id, x: spot.x, y: spot.y, w, h };
    if (baseId === "btnCustomRect" || baseId === "btnCustomCircle") {
      raw.isCustom = true;
      const text = prompt("自定义按钮文字", "自定义") || "自定义";
      const bits = prompt("绑定按键值（十六进制掩码，逗号分隔，可留空）", "") || "";
      raw.customText = text;
      raw.customBits = bits
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parseInt(s, s.startsWith("0x") ? 16 : 16) >>> 0);
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
    this._syncEditBar();
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
