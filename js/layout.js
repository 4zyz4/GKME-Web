// GKME-Web — the gamepad layout engine.
//
// Re-implements the essential behaviour of com.zyz4.gkme.view.GamepadLayout:
// a fixed 120-column grid, custom-drawn controls, grid-coordinate hit testing
// and a runtime touch dispatch. Rendering is canvas-based; input is handled
// with pointer events on the same canvas and manually hit-tested so multi-touch
// works exactly like the Android GestureDetector-free pipeline.

import {
  BIT, DPAD, Kb, CONTROLS, baseId, getControl, isKeypadId, lockAspectFor,
  controlLabel, keyboardCaption, KB_MODIFIER_CODES, MODIFIER_BITS,
} from "./controls.js";

export const GRID_COLS = 120;

const DEFAULTS = {
  visible: true,
  lockAspect: false,
  swipeTrigger: false,
  rotation: 0,
  isCustom: false,
  customText: null,
  customBits: null,
  roundShape: false,
  doubleClickEnable: true,
  isKeypad: false,
  isKeyboard: false,
  keypadEightWay: false,
  centerShape: "SQUARE",
  joystickSensitivity: 100,
  touchpadMode: false,
  prediction: false,
  deadZone: 0,
  reverseDeadZone: 0,
  idleOpacity: 100,
  activeOpacity: 100,
  followAreaEnabled: false,
  overlapTrigger: true,
  linearTriggerEnabled: false,
  slideDirection: "DOWN",
  travelDistance: 10,
  gyroActivate: false,
  autoHold: false,
  mouseSensitivity: 1,
  scrollSensitivity: 0.1,
  mouseMoveSlop: 4,
  invertScrollV: false,
  invertScrollH: false,
};

export function normalizeButton(raw) {
  const b = Object.assign({}, DEFAULTS, raw);
  if (raw.width !== undefined && raw.w === undefined) b.w = raw.width;
  if (raw.height !== undefined && raw.h === undefined) b.h = raw.height;
  if (b.w === undefined) b.w = 10;
  if (b.h === undefined) b.h = 10;
  b.lockAspect = raw.lockAspect !== undefined ? raw.lockAspect : lockAspectFor(b.id);
  const c = getControl(b.id);
  if (c && c.isKeyboard) b.isKeyboard = true;
  if (c && c.isKeypad) b.isKeypad = true;
  if (c && c.isCustom) b.isCustom = true;
  if (c && c.isTrigger) b.isTrigger = true;
  if (c && c.isJoystick) { b.isJoystick = true; b.axis = c.axis; }
  if (c && c.isTouchpad) b.isTouchpad = true;
  if (c && c.isMousepad) b.isMousepad = true;
  if (c && c.isDpadPad) b.isDpadPad = true;
  if (c && c.isDpad) b.isDpad = true;
  if (c && c.isSettings) b.isSettings = true;
  if (b.isCustom && !b.customBits) b.customBits = [];
  if (b.isCustom && b.customText == null) b.customText = "自定义";
  return b;
}

export const DEFAULT_APPEARANCE = {
  background: { color: "rgba(0,0,0,0)", image: null },
  button: {
    fill: "rgba(255,255,255,0.10)",
    fillActive: "rgba(255,255,255,0.35)",
    stroke: "rgba(255,255,255,0.25)",
    text: "rgba(255,255,255,0.85)",
  },
  joystick: {
    base: "rgba(0,0,0,0.35)",
    stroke: "#333333",
    thumb: "#1a1a1a",
    thumbStroke: "rgba(255,255,255,0.3)",
  },
  touchpad: {
    fill: "rgba(18,18,18,0.6)",
    stroke: "rgba(255,255,255,0.25)",
  },
};

export class GamepadLayout {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cb = callbacks || {};
    this.preset = { buttons: [] };
    this.buttons = [];
    this.displayMode = "XBOX";
    this.appearance = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
    this.editMode = false;
    this.selectedId = null;
    this.showGrid = false;
    this.pressedBits = 0;
    this.stickVisual = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    this.controlActive = new Map();
    this.autoHoldState = new Map();

    this._pointers = new Map();
    this._dpr = Math.max(1, window.devicePixelRatio || 1);
    this._layout = { originX: 0, originY: 0, cell: 1 };

    this._bind();
    this.resize();
  }

  // ── geometry ──
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    this._dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * this._dpr);
    this.canvas.height = Math.round(cssH * this._dpr);
    this.cssW = cssW;
    this.cssH = cssH;

    const cell = cssW / GRID_COLS;
    const rows = cssH / cell;
    this._layout = {
      cell,
      rows,
      originX: 0,
      originY: 0,
    };
    this.render();
  }

  cellPx() {
    return this._layout.cell;
  }

  gridRect(b) {
    const { cell, originX, originY } = this._layout;
    return {
      x: originX + b.x * cell,
      y: originY + b.y * cell,
      w: b.w * cell,
      h: b.h * cell,
    };
  }

  setPreset(preset) {
    this.preset = preset || { buttons: [] };
    this.buttons = (this.preset.buttons || []).map(normalizeButton);
    this.selectedId = null;
    this.render();
  }

  getButton(id) {
    return this.buttons.find((b) => b.id === id);
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    this.render();
  }

  setAppearance(app) {
    if (app) this.appearance = app;
    this.render();
  }

  setPressedBits(bits) {
    this.pressedBits = bits >>> 0;
  }

  setStickVisual(axis, x, y) {
    this.stickVisual[axis] = { x, y };
  }

  serialize() {
    return {
      version: this.preset.version || 1,
      gyroOrientation: this.preset.gyroOrientation || null,
      gyroActivateMode: this.preset.gyroActivateMode || null,
      gyroMode: this.preset.gyroMode || null,
      gyroModeSensitivity: this.preset.gyroModeSensitivity,
      buttons: this.buttons.map((b) => {
        const o = { id: b.id, x: b.x, y: b.y, width: b.w, height: b.h, rotation: b.rotation || 0 };
        if (!b.visible) o.visible = false;
        if (b.isCustom) { o.isCustom = true; o.customText = b.customText; o.customBits = b.customBits || []; }
        if (b.roundShape) o.roundShape = true;
        if (b.gyroActivate) o.gyroActivate = true;
        if (b.autoHold) o.autoHold = true;
        if (b.overlapTrigger === false) o.overlapTrigger = false;
        if (b.linearTriggerEnabled) { o.linearTriggerEnabled = true; o.slideDirection = b.slideDirection; o.travelDistance = b.travelDistance; }
        if (b.isKeypad) { o.keypadTexts = b.keypadTexts; o.keypadBits = b.keypadBits; o.keypadEightWay = b.keypadEightWay; }
        return o;
      }),
      gyroStickCurve: this.preset.gyroStickCurve || null,
    };
  }

  // ── rendering ──
  render() {
    const ctx = this.ctx;
    const { cell } = this._layout;
    ctx.save();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const bg = this.appearance.background;
    if (bg && bg.image) {
      this._drawCoverImage(bg.image);
    } else if (bg && bg.color && bg.color !== "rgba(0,0,0,0)") {
      ctx.fillStyle = bg.color;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }

    if (this.showGrid && this.editMode) this._drawGrid();

    for (const b of this.buttons) {
      if (!b.visible) continue;
      this._drawControl(b);
    }

    if (this.editMode && this.selectedId) this._drawSelection(this.getButton(this.selectedId));
    ctx.restore();
  }

  _drawCoverImage(img) {
    const ctx = this.ctx;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(this.cssW / iw, this.cssH / ih);
    const w = iw * scale;
    const h = ih * scale;
    ctx.drawImage(img, (this.cssW - w) / 2, (this.cssH - h) / 2, w, h);
  }

  _drawGrid() {
    const ctx = this.ctx;
    const { cell } = this._layout;
    ctx.strokeStyle = "rgba(80,160,255,0.18)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= GRID_COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell, 0);
      ctx.lineTo(x * cell, this.cssH);
      ctx.stroke();
    }
    for (let y = 0; y * cell <= this.cssH; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell);
      ctx.lineTo(this.cssW, y * cell);
      ctx.stroke();
    }
  }

  _active(b) {
    if (this.controlActive.get(b.id)) return true;
    const c = getControl(b.id);
    if (c && c.bit) return (this.pressedBits & c.bit) !== 0;
    return false;
  }

  _rectPath(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (r <= 0) {
      ctx.rect(x, y, w, h);
      return;
    }
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _drawControl(b) {
    const r = this.gridRect(b);
    if (r.w <= 0 || r.h <= 0) return;
    const ctx = this.ctx;
    const active = this._active(b);
    const opacity = (active ? b.activeOpacity : b.idleOpacity) / 100;
    if (opacity <= 0) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
    if (b.rotation) ctx.rotate((b.rotation * Math.PI) / 180);

    if (b.isJoystick) this._drawJoystick(b, r);
    else if (b.isDpadPad) this._drawDpadPad(b, r, active);
    else if (b.isKeypad) this._drawKeypad(b, r);
    else if (b.isTouchpad || b.isMousepad) this._drawPad(b, r);
    else this._drawButton(b, r, active);

    ctx.restore();
  }

  _drawButton(b, r, active) {
    const ctx = this.ctx;
    const app = this.appearance.button;
    const w = r.w;
    const h = r.h;
    const isRound = b.roundShape || (b.lockAspect && Math.abs(w - h) < 1);
    if (b.fillImage) {
      ctx.save();
      this._rectPath(-w / 2, -h / 2, w, h, isRound ? Math.min(w, h) / 2 : Math.min(8, h * 0.25));
      ctx.clip();
      const img = b.fillImage;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (iw && ih) {
        const s = Math.max(w / iw, h / ih);
        ctx.drawImage(img, (-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s);
      }
      ctx.restore();
    } else {
      ctx.fillStyle = active ? (b.activeColor || app.fillActive) : (b.color || app.fill);
      this._rectPath(-w / 2, -h / 2, w, h, isRound ? Math.min(w, h) / 2 : Math.min(8, h * 0.25));
      ctx.fill();
    }
    ctx.strokeStyle = b.strokeColor || app.stroke;
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.05);
    this._rectPath(-w / 2, -h / 2, w, h, isRound ? Math.min(w, h) / 2 : Math.min(8, h * 0.25));
    ctx.stroke();

    // label
    let label = "";
    if (b.isCustom) label = b.customText || "";
    else if (b.isKeyboard) label = keyboardCaption(b.keyCode, this.keyboardShift);
    else label = controlLabel(b.id, this.displayMode);
    if (label) {
      ctx.fillStyle = b.textColor || app.text;
      const fs = Math.min(w, h) * (label.length > 2 ? 0.34 : 0.5);
      ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 0, 1);
    }
    if (b.isTrigger && b.linearTriggerEnabled) {
      // travel indicator
      ctx.strokeStyle = "rgba(120,180,255,0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4);
    }
  }

  _drawJoystick(b, r) {
    const ctx = this.ctx;
    const app = this.appearance.joystick;
    const d = Math.min(r.w, r.h);
    const rad = d / 2;
    ctx.beginPath();
    ctx.arc(0, 0, rad * 0.92, 0, Math.PI * 2);
    ctx.fillStyle = app.base;
    ctx.fill();
    ctx.lineWidth = Math.max(1, rad * 0.06);
    ctx.strokeStyle = app.stroke;
    ctx.stroke();

    const vis = this.stickVisual[b.axis] || { x: 0, y: 0 };
    const kx = (vis.x / 32767) * rad * 0.6;
    const ky = (vis.y / 32767) * rad * 0.6;
    const thumbR = rad * 0.42;
    ctx.beginPath();
    ctx.arc(kx, ky, thumbR, 0, Math.PI * 2);
    ctx.fillStyle = app.thumb;
    ctx.fill();
    ctx.lineWidth = Math.max(1, rad * 0.04);
    ctx.strokeStyle = app.thumbStroke;
    ctx.stroke();

    if (b.deadZone > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.92 * (b.deadZone / 100), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,210,80,0.7)";
      ctx.stroke();
    }
    if (b.reverseDeadZone > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.92 * (1 - b.reverseDeadZone / 100), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(80,160,255,0.7)";
      ctx.stroke();
    }
  }

  _drawDpadPad(b, r, active) {
    const ctx = this.ctx;
    const app = this.appearance.button;
    const w = r.w;
    const h = r.h;
    const hat = b._hat || 0;
    const armW = Math.min(w, h) * 0.34;
    const fill = (on) => (on ? app.fillActive : app.fill);

    // vertical bar (up/down)
    ctx.beginPath();
    ctx.rect(-armW / 2, -h / 2, armW, h);
    ctx.fillStyle = fill(hat & (DPAD.UP | DPAD.DOWN));
    ctx.fill();
    ctx.strokeStyle = app.stroke;
    ctx.lineWidth = Math.max(1, w * 0.012);
    ctx.stroke();

    // horizontal bar (left/right)
    ctx.beginPath();
    ctx.rect(-w / 2, -armW / 2, w, armW);
    ctx.fillStyle = fill(hat & (DPAD.LEFT | DPAD.RIGHT));
    ctx.fill();
    ctx.stroke();

    // centre
    ctx.beginPath();
    ctx.arc(0, 0, armW * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = fill(active && !hat);
    ctx.fill();
    ctx.stroke();
  }

  _drawKeypad(b, r) {
    const ctx = this.ctx;
    const app = this.appearance.button;
    const w = r.w;
    const h = r.h;
    ctx.fillStyle = app.fill;
    ctx.strokeStyle = app.stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 4 wedges
    const texts = b.keypadTexts || ["上", "下", "左", "右", "中", "左上", "右上", "左下", "右下"];
    const label = texts[b._region != null ? b._region : 4] || "";
    ctx.fillStyle = app.text;
    const fs = Math.min(w, h) * 0.34;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 1);
  }

  _drawPad(b, r) {
    const ctx = this.ctx;
    const app = this.appearance.touchpad;
    const w = r.w;
    const h = r.h;
    ctx.fillStyle = b.color || app.fill;
    this._rectPath(-w / 2, -h / 2, w, h, Math.min(10, h * 0.12));
    ctx.fill();
    ctx.strokeStyle = app.stroke;
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.02);
    this._rectPath(-w / 2, -h / 2, w, h, Math.min(10, h * 0.12));
    ctx.stroke();

    if (b._touchPoints) {
      for (const p of b._touchPoints) {
        const px = (p.nx - 0.5) * w;
        const py = (p.ny - 0.5) * h;
        ctx.beginPath();
        ctx.arc(px, py, Math.min(w, h) * 0.05, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(120,180,255,0.85)";
        ctx.fill();
      }
    }
  }

  _drawSelection(b) {
    if (!b) return;
    const ctx = this.ctx;
    const r = this.gridRect(b);
    ctx.save();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.strokeStyle = "#4ea1ff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();

    const hs = 16;
    ctx.save();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.fillStyle = "#4ea1ff";
    ctx.fillRect(r.x + r.w - hs / 2, r.y + r.h - hs / 2, hs, hs);
    ctx.restore();
  }

  // ── hit testing ──
  _hitTest(px, py) {
    const { cell, originX, originY } = this._layout;
    // settings button always wins
    const settings = this.buttons.find((b) => b.isSettings && b.visible);
    if (settings) {
      const r = this.gridRect(settings);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return settings;
    }
    let found = null;
    for (const b of this.buttons) {
      if (!b.visible) continue;
      const r = this.gridRect(b);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        found = b; // last drawn = topmost
      }
    }
    return found;
  }

  _hitHandle(px, py) {
    const b = this.getButton(this.selectedId);
    if (!b) return false;
    const r = this.gridRect(b);
    const hs = 22;
    return Math.abs(px - (r.x + r.w)) < hs && Math.abs(py - (r.y + r.h)) < hs;
  }

  pxToGrid(px, py) {
    const { cell, originX, originY } = this._layout;
    return { gx: (px - originX) / cell, gy: (py - originY) / cell };
  }

  // ── pointer handling ──
  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e));
    c.addEventListener("pointermove", (e) => this._onMove(e));
    c.addEventListener("pointerup", (e) => this._onUp(e));
    c.addEventListener("pointercancel", (e) => this._onUp(e));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  }

  _onDown(e) {
    e.preventDefault();
    const { px, py } = this._pos(e);
    if (this.editMode) {
      this._editDown(e, px, py);
      return;
    }
    const b = this._hitTest(px, py);
    if (!b) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}

    if (b.isSettings) {
      this.cb.onOpenSettings && this.cb.onOpenSettings();
      return;
    }

    const isAutoHold = b.autoHold;
    const alreadyActive = this.controlActive.get(b.id);

    if (b.isJoystick) {
      this._pointers.set(e.pointerId, { id: b.id, kind: "stick", axis: b.axis, b, gx: null, gy: null });
      this._updateStick(e.pointerId, px, py);
      return;
    }
    if (b.isDpadPad) {
      this._pointers.set(e.pointerId, { id: b.id, kind: "dpad", b });
      this._updateDpad(e.pointerId, px, py);
      return;
    }
    if (b.isTouchpad) {
      this._pointers.set(e.pointerId, { id: b.id, kind: "touchpad", b, px, py });
      this._updateTouchpad(b);
      return;
    }
    if (b.isMousepad) {
      this._pointers.set(e.pointerId, { id: b.id, kind: "mousepad", b, startX: px, startY: py, lastX: px, lastY: py, startT: performance.now(), moved: false });
      this.controlActive.set(b.id, true);
      return;
    }
    if (b.isKeypad) {
      this._pointers.set(e.pointerId, { id: b.id, kind: "keypad", b });
      this._updateKeypad(e.pointerId, px, py);
      return;
    }
    if (b.isTrigger && b.linearTriggerEnabled) {
      this._pointers.set(e.pointerId, { id: b.id, kind: "trigger", b });
      this._updateTrigger(e.pointerId, px, py);
      return;
    }

    // plain button / custom
    if (isAutoHold) {
      if (alreadyActive) this._releaseControl(b);
      else this._pressControl(b);
      return;
    }
    this._pointers.set(e.pointerId, { id: b.id, kind: "button", b });
    this._pressControl(b);
  }

  _onMove(e) {
    if (this.editMode) {
      this._editMove(e);
      return;
    }
    const info = this._pointers.get(e.pointerId);
    if (!info) return;
    const { px, py } = this._pos(e);
    if (info.kind === "stick") this._updateStick(e.pointerId, px, py);
    else if (info.kind === "dpad") this._updateDpad(e.pointerId, px, py);
    else if (info.kind === "keypad") this._updateKeypad(e.pointerId, px, py);
    else if (info.kind === "trigger") this._updateTrigger(e.pointerId, px, py);
    else if (info.kind === "mousepad") this._updateMousepad(e.pointerId, px, py);
    else if (info.kind === "touchpad") { info.px = px; info.py = py; this._updateTouchpad(info.b); }
  }

  _onUp(e) {
    if (this.editMode) {
      this._editUp(e);
      return;
    }
    const info = this._pointers.get(e.pointerId);
    if (!info) return;
    this._pointers.delete(e.pointerId);

    if (info.kind === "stick") {
      this._setStick(info.axis, 0, 0);
      this.controlActive.set(info.id, false);
    } else if (info.kind === "dpad") {
      info.b._hat = 1;
      this.cb.onDpad && this.cb.onDpad(0);
      this.controlActive.set(info.id, false);
    } else if (info.kind === "keypad") {
      if (info.b._region != null) {
        const bits = (info.b.keypadBits && info.b.keypadBits[info.b._region]) || [];
        this.cb.onCustomBits && this.cb.onCustomBits(bits, false);
      }
      info.b._region = null;
      this.controlActive.set(info.id, false);
    } else if (info.kind === "trigger") {
      this.cb.onTrigger && this.cb.onTrigger(info.b._which, 0);
      this.controlActive.set(info.id, false);
    } else if (info.kind === "mousepad") {
      this._finishMousepad(info);
    } else if (info.kind === "touchpad") {
      this._updateTouchpad(info.b);
    } else if (info.kind === "button") {
      this._releaseControl(info.b);
    }
  }

  _pressControl(b) {
    const c = getControl(b.id);
    if (c && c.isKeyboard) {
      this.controlActive.set(b.id, true);
      this.cb.onKey && this.cb.onKey(c.keyCode, true);
    } else if (c && c.bit) {
      this.controlActive.set(b.id, true);
      this.cb.onButtonDown && this.cb.onButtonDown(b.id, c.bit);
    } else if (b.isCustom) {
      this.controlActive.set(b.id, true);
      this.cb.onCustomBits && this.cb.onCustomBits(b.customBits || [], true);
      if (b.gyroActivate) this.cb.onGyroActivate && this.cb.onGyroActivate(true);
    }
    this.render();
  }

  _releaseControl(b) {
    const c = getControl(b.id);
    if (c && c.isKeyboard) {
      this.controlActive.set(b.id, false);
      this.cb.onKey && this.cb.onKey(c.keyCode, false);
    } else if (c && c.bit) {
      this.controlActive.set(b.id, false);
      this.cb.onButtonUp && this.cb.onButtonUp(b.id, c.bit);
    } else if (b.isCustom) {
      this.controlActive.set(b.id, false);
      this.cb.onCustomBits && this.cb.onCustomBits(b.customBits || [], false);
      if (b.gyroActivate) this.cb.onGyroActivate && this.cb.onGyroActivate(false);
    }
    this.render();
  }

  setKeyboardShift(active) {
    if (this.keyboardShift === active) return;
    this.keyboardShift = active;
    this.render();
  }

  _setStick(axis, x, y) {
    this.stickVisual[axis] = { x, y };
    this.cb.onStick && this.cb.onStick(axis, x, y);
  }

  _updateStick(pointerId, px, py) {
    const info = this._pointers.get(pointerId);
    if (!info) return;
    const r = this.gridRect(info.b);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = Math.min(r.w, r.h) / 2;
    let dx = (px - cx) / rad;
    let dy = (py - cy) / rad;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    const sens = (info.b.joystickSensitivity || 100) / 100;
    let nx = dx * sens;
    let ny = dy * sens;
    const dz = (info.b.deadZone || 0) / 100;
    if (dz > 0) {
      const l2 = Math.hypot(nx, ny);
      if (l2 < dz) {
        nx = 0;
        ny = 0;
      } else {
        const scale = (l2 - dz) / (1 - dz) / l2;
        nx *= scale;
        ny *= scale;
      }
    }
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    this.controlActive.set(info.id, Math.hypot(nx, ny) > 0.001);
    // Y is emitted screen-down-positive to match the host / Android convention
    // (HID stick Y: min = up, max = down).
    this._setStick(info.axis, Math.round(clamp(nx) * 32767), Math.round(clamp(ny) * 32767));
    this.render();
  }

  _updateDpad(pointerId, px, py) {
    const info = this._pointers.get(pointerId);
    if (!info) return;
    const r = this.gridRect(info.b);
    const nx = (px - (r.x + r.w / 2)) / (r.w / 2);
    const ny = (py - (r.y + r.h / 2)) / (r.h / 2);
    let hat = 0;
    const t = 0.32;
    if (Math.hypot(nx, ny) > t) {
      if (nx > t) hat |= DPAD.RIGHT;
      if (nx < -t) hat |= DPAD.LEFT;
      if (ny > t) hat |= DPAD.DOWN;
      if (ny < -t) hat |= DPAD.UP;
    }
    info.b._hat = hat;
    this.controlActive.set(info.id, hat !== 0);
    this.cb.onDpad && this.cb.onDpad(hat);
    this.render();
  }

  _updateKeypad(pointerId, px, py) {
    const info = this._pointers.get(pointerId);
    if (!info) return;
    const b = info.b;
    const r = this.gridRect(b);
    const nx = (px - (r.x + r.w / 2)) / (r.w / 2);
    const ny = (py - (r.y + r.h / 2)) / (r.h / 2);
    // region: 4 = center; 0 up,1 down,2 left,3 right; diagonals 5..8
    let region = 4;
    const t = 0.35;
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    if (ax > t && ay > t) {
      if (ny < 0 && nx < 0) region = 5;
      else if (ny < 0 && nx > 0) region = 6;
      else if (ny > 0 && nx < 0) region = 7;
      else region = 8;
      if (!b.keypadEightWay) region = ax > ay ? (nx > 0 ? 3 : 2) : (ny > 0 ? 1 : 0);
    } else if (ax > t) {
      region = nx > 0 ? 3 : 2;
    } else if (ay > t) {
      region = ny > 0 ? 1 : 0;
    }
    if (b._region !== region) {
      if (b._region != null) {
        const oldBits = (b.keypadBits && b.keypadBits[b._region]) || [];
        this.cb.onCustomBits && this.cb.onCustomBits(oldBits, false);
      }
      b._region = region;
      if (region !== 4) {
        const bits = (b.keypadBits && b.keypadBits[region]) || [];
        this.cb.onCustomBits && this.cb.onCustomBits(bits, true);
      }
    }
    this.controlActive.set(b.id, region !== 4);
    this.render();
  }

  _updateTrigger(pointerId, px, py) {
    const info = this._pointers.get(pointerId);
    if (!info) return;
    const b = info.b;
    const r = this.gridRect(b);
    let prog = 0;
    const dist = Math.max(1, b.travelDistance);
    switch (b.slideDirection) {
      case "UP": prog = (r.y + r.h - py) / (r.h); break;
      case "LEFT": prog = (r.x + r.w - px) / r.w; break;
      case "RIGHT": prog = (px - r.x) / r.w; break;
      default: prog = (py - r.y) / r.h;
    }
    prog = Math.max(0, Math.min(1, prog));
    const which = baseId(b.id) === "btnLT" ? "left" : "right";
    b._which = which;
    const value = Math.round(prog * 255);
    this.controlActive.set(b.id, value > 8);
    this.cb.onTrigger && this.cb.onTrigger(which, value);
    this.render();
  }

  _updateTouchpad(b) {
    const r = this.gridRect(b);
    const points = [];
    let idx = 0;
    for (const [, info] of this._pointers) {
      if (info.kind !== "touchpad" || info.b !== b) continue;
      // pointer position is tracked via clientX/clientY stored below
      points.push({ id: idx, x: info.px, y: info.py, active: true });
      idx++;
    }
    // eslint-disable-next-line no-self-assign
    const touches = points.map((p) => ({
      id: p.id,
      x: Math.round(((p.x - r.x) / r.w) * 1919),
      y: Math.round(((p.y - r.y) / r.h) * 942),
      active: true,
    }));
    b._touchPoints = points.map((p) => ({ nx: (p.x - r.x) / r.w, ny: (p.y - r.y) / r.h }));
    this.cb.onTouchpad && this.cb.onTouchpad(touches);
    this.render();
  }

  _updateMousepad(pointerId, px, py) {
    const info = this._pointers.get(pointerId);
    if (!info) return;
    const dx = px - info.lastX;
    const dy = py - info.lastY;
    info.lastX = px;
    info.lastY = py;
    if (Math.hypot(px - info.startX, py - info.startY) > (info.b.mouseMoveSlop || 4)) info.moved = true;
    this.cb.onMouseMove && this.cb.onMouseMove(dx, dy, info.b);
  }

  _finishMousepad(info) {
    const dt = performance.now() - info.startT;
    if (!info.moved && dt < 250) {
      this.cb.onMouseTap && this.cb.onMouseTap(info.b);
    }
    this.controlActive.set(info.b.id, false);
  }

  // ── edit mode ──
  _editDown(e, px, py) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    if (this.selectedId && this._hitHandle(px, py)) {
      const b = this.getButton(this.selectedId);
      this._edit = { pointerId: e.pointerId, mode: "resize", b, start: { ...b }, gx: px, gy: py };
      return;
    }
    const hit = this._hitTest(px, py);
    if (hit) {
      this.selectedId = hit.id;
      this._edit = { pointerId: e.pointerId, mode: "move", b: hit, start: { x: hit.x, y: hit.y }, gx: px, gy: py };
    } else {
      this.selectedId = null;
      this._edit = null;
      this.cb.onSelect && this.cb.onSelect(null);
    }
    this.render();
    if (hit) this.cb.onSelect && this.cb.onSelect(hit.id);
  }

  _editMove(e) {
    if (!this._edit || this._edit.pointerId !== e.pointerId) return;
    const { loc } = { loc: this._layout };
    const cell = loc.cell;
    const { px, py } = this._pos(e);
    const dgx = Math.round((px - this._edit.gx) / cell);
    const dgy = Math.round((py - this._edit.gy) / cell);
    const b = this._edit.b;
    if (this._edit.mode === "move") {
      let nx = this._edit.start.x + dgx;
      let ny = this._edit.start.y + dgy;
      b.x = Math.max(0, Math.min(GRID_COLS - b.w, nx));
      b.y = Math.max(0, ny);
    } else {
      let nw = this._edit.start.w + dgx;
      let nh = this._edit.start.h + dgy;
      if (b.lockAspect) nh = nw;
      b.w = Math.max(3, nw);
      b.h = Math.max(3, nh);
    }
    this.cb.onEditChanged && this.cb.onEditChanged();
    this.render();
  }

  _editUp(e) {
    if (this._edit && this._edit.pointerId === e.pointerId) this._edit = null;
  }
}
