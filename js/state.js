// GKME-Web — persisted settings, presets and the live input state model.

import { BUILTIN_PRESETS, FULL_CON } from "./presets.js";
import { normalizeButton } from "./layout.js";
const SETTINGS_KEY = "gkme.settings.v1";
const PRESETS_KEY = "gkme.presets.v1";
const ACTIVE_PRESET_KEY = "gkme.activePreset.v1";

export const DEFAULT_SETTINGS = {
  displayMode: "XBOX",
  pollingHz: 125,
  haptics: {
    buttonVibrate: true,
    buttonVibrateMs: 18,
    gameVibrate: true,
    swapMotors: false,
  },
  mouse: {
    pointerAcceleration: 1,
    scrollSensitivity: 0.1,
    invertScrollV: false,
    invertScrollH: false,
  },
  screen: {
    keepAwake: true,
    screenOff: false,
  },
  physical: {
    forward: true,
  },
  meta: {
    deviceName: "",
  },
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" && base[k] !== null) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

export function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export function savePresets(presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {}
}

export function ensurePresets() {
  // The web build ships only the touch gamepad preset; keyboard/mouse layouts
  // are intentionally not part of GKME-Web.
  let presets = loadPresets() || {};
  delete presets.keyboard;
  delete presets.mouse;
  if (!presets.full_con) presets.full_con = JSON.parse(JSON.stringify(FULL_CON));
  savePresets(presets);
  return presets;
}

export function getActivePresetName() {
  const name = localStorage.getItem(ACTIVE_PRESET_KEY) || "full_con";
  return name === "keyboard" || name === "mouse" ? "full_con" : name;
}

export function setActivePresetName(name) {
  localStorage.setItem(ACTIVE_PRESET_KEY, name);
}

// Minimum time (ms) an input stays "on" after being activated. This must be
// longer than the host/game sampling interval so a fast tap is not skipped
// between two of the receiver's polls (1 frame at 125Hz is only ~8ms, which a
// 60Hz poller can miss entirely).
const MIN_PRESS_MS = 60;

// Iterate the individual bits set in a uint32 mask.
function forEachBit(mask, fn) {
  let m = mask >>> 0;
  while (m) {
    const b = (m & -m) >>> 0;
    fn(b);
    m = (m & (m - 1)) >>> 0;
  }
}

// ── Live input state ──
// Aggregates touch controls, physical controller forwarding and keyboard/mouse
// input into one GamepadInput-shaped snapshot.
export class InputState {
  constructor() {
    this.buttons = 0; // GKME bitmask (uint32)
    this.dpad = 0;
    this.leftStickX = 0;
    this.leftStickY = 0;
    this.rightStickX = 0;
    this.rightStickY = 0;
    this.leftTrigger = 0;
    this.rightTrigger = 0;
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.mouseWheel = 0;
    this.mousePan = 0;
    this.mouseButtons = 0;
    this.touches = [];
    // keyboard
    this.kbModifiers = 0;
    this.kbKeys = new Set(); // usages
    // sources keep button/dpad/mouse contributions independent
    this._touchButtons = 0;
    this._physicalButtons = 0;
    this._customBits = 0;
    this._mouseTouch = 0;
    this._mouseGesture = 0;
    this._touchDpad = 0;
    this._physicalDpad = 0;
    // Time-based holds: anything activated since the last send stays "on" for
    // MIN_PRESS_MS so a fast press+release still reaches the host as a press.
    this._btnHold = new Map();  // button/custom bit -> expiry timestamp
    this._dpadHold = new Map(); // dpad direction bit -> expiry timestamp
    this._keyHold = new Map();  // keyboard scan code -> expiry timestamp
    this._modHold = new Map();  // modifier bit -> expiry timestamp
    this._lHoldUntil = 0;
    this._lHoldVal = 0;
    this._rHoldUntil = 0;
    this._rHoldVal = 0;
    // Effective hold window; the app raises this to >= 2 send intervals.
    this.minPressMs = MIN_PRESS_MS;
  }

  holdButtons(bits) {
    const until = performance.now() + this.minPressMs;
    forEachBit(bits, (b) => this._btnHold.set(b, until));
  }

  holdDpad(bits) {
    const until = performance.now() + this.minPressMs;
    forEachBit(bits, (b) => this._dpadHold.set(b, until));
  }

  holdKeys(codes) {
    const until = performance.now() + this.minPressMs;
    for (const c of codes) this._keyHold.set(c, until);
  }

  holdModifier(bits) {
    const until = performance.now() + this.minPressMs;
    forEachBit(bits, (b) => this._modHold.set(b, until));
  }

  holdTrigger(which, value) {
    if (!value) return;
    const until = performance.now() + this.minPressMs;
    if (which === "left") {
      this._lHoldUntil = until;
      this._lHoldVal = Math.max(this._lHoldVal, value);
    } else {
      this._rHoldUntil = until;
      this._rHoldVal = Math.max(this._rHoldVal, value);
    }
  }

  _liveHoldMask(map, now) {
    let mask = 0;
    for (const [b, exp] of map) {
      if (now < exp) mask |= b;
      else map.delete(b);
    }
    return mask >>> 0;
  }

  recomputeButtons() {
    this.buttons = (this._touchButtons | this._physicalButtons | this._customBits | this._mouseTouch | this._mouseGesture) >>> 0;
    this.dpad = this._touchDpad | this._physicalDpad;
  }

  toInput() {
    this.recomputeButtons();
    const now = performance.now();
    const heldButtons = this._liveHoldMask(this._btnHold, now);
    const heldDpad = this._liveHoldMask(this._dpadHold, now);
    const heldMods = this._liveHoldMask(this._modHold, now);
    const scanCodes = Array.from(this.kbKeys);
    for (const [code, exp] of this._keyHold) {
      if (now < exp) {
        if (!this.kbKeys.has(code)) scanCodes.push(code);
      } else {
        this._keyHold.delete(code);
      }
    }
    return {
      buttons: (this.buttons | heldButtons) >>> 0,
      dpad: (this.dpad | heldDpad) >>> 0,
      leftStickX: this.leftStickX,
      leftStickY: this.leftStickY,
      rightStickX: this.rightStickX,
      rightStickY: this.rightStickY,
      leftTrigger: Math.max(this.leftTrigger, now < this._lHoldUntil ? this._lHoldVal : 0),
      rightTrigger: Math.max(this.rightTrigger, now < this._rHoldUntil ? this._rHoldVal : 0),
      mouseDx: this.mouseDx,
      mouseDy: this.mouseDy,
      mouseWheel: this.mouseWheel,
      mousePan: this.mousePan,
      mouseButtons: this.mouseButtons,
      touches: this.touches,
      scanCodes,
      modifiers: (this.kbModifiers | heldMods) >>> 0,
    };
  }
}
