// GKME-Web — haptics via the Vibration API (approximation of the phone's
// motor / RichTap output). Gracefully degrades where unsupported.

export class Haptics {
  constructor(settings) {
    this.settings = settings;
    this.supported = typeof navigator !== "undefined" && "vibrate" in navigator;
    this._lastVib = 0;
    this._lastTime = 0;
  }

  setSettings(s) {
    this.settings = s;
  }

  /** Short pulse on a button press / release. */
  buttonPulse() {
    if (!this.supported) return;
    if (!this.settings.haptics.buttonVibrate) return;
    // Throttle: a stream of presses must not vibrate continuously.
    const now = performance.now();
    if (now - this._lastTime < 40) return;
    this._lastTime = now;
    try {
      navigator.vibrate(Math.max(10, this.settings.haptics.buttonVibrateMs || 18));
    } catch {}
  }

  /** Server-driven rumble (Vibration: large_motor / small_motor, 0..255). */
  rumble(large, small) {
    if (!this.supported) return;
    if (!this.settings.haptics.gameVibrate) return;
    let l = large | 0;
    let s = small | 0;
    if (this.settings.haptics.swapMotors) {
      const t = l;
      l = s;
      s = t;
    }
    const mag = Math.max(l, s);
    if (mag < 8) {
      if (this._lastVib !== 0) {
        try {
          navigator.vibrate(0);
        } catch {}
        this._lastVib = 0;
      }
      return;
    }
    const now = performance.now();
    // The protocol keeps re-sending the same rumble state; only re-trigger
    // when the magnitude meaningfully changes or enough time passed.
    if (Math.abs(mag - this._lastVib) < 24 && now - this._lastTime < 120) return;
    this._lastVib = mag;
    this._lastTime = now;
    try {
      navigator.vibrate(90);
    } catch {}
  }

  stop() {
    if (!this.supported) return;
    try {
      navigator.vibrate(0);
    } catch {}
    this._lastVib = 0;
  }
}
