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
  }

  recomputeButtons() {
    this.buttons = (this._touchButtons | this._physicalButtons | this._customBits | this._mouseTouch | this._mouseGesture) >>> 0;
    this.dpad = this._touchDpad | this._physicalDpad;
  }

  toInput() {
    this.recomputeButtons();
    return {
      buttons: this.buttons,
      dpad: this.dpad,
      leftStickX: this.leftStickX,
      leftStickY: this.leftStickY,
      rightStickX: this.rightStickX,
      rightStickY: this.rightStickY,
      leftTrigger: this.leftTrigger,
      rightTrigger: this.rightTrigger,
      mouseDx: this.mouseDx,
      mouseDy: this.mouseDy,
      mouseWheel: this.mouseWheel,
      mousePan: this.mousePan,
      mouseButtons: this.mouseButtons,
      touches: this.touches,
      scanCodes: Array.from(this.kbKeys),
      modifiers: this.kbModifiers,
    };
  }
}
