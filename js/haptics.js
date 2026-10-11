// GKME-Web — haptics via the Vibration API (approximation of the phone's
// motor / RichTap output). Gracefully degrades where unsupported.

export class Haptics {
  constructor(settings) {
    this.settings = settings;
    this.supported = typeof navigator !== "undefined" && "vibrate" in navigator;
    this._lastVib = 0;
    this._lastButtonTime = 0;
    this._lastRumbleTime = 0;
  }

  setSettings(s) {
    this.settings = s;
  }

  // The Vibration API is supposed to be async, but several mobile WebViews
  // block the main thread for the whole vibration. Calling it from inside a
  // pointer/key handler would then stall input dispatch and the send loop,
  // which shows up as a >100ms delay on buttons only (the stick never
  // vibrates). Defer to a later task so the handler and the current input
  // frame are already processed before any block happens.
  _vibrate(ms) {
    setTimeout(() => {
      try {
        navigator.vibrate(ms);
      } catch {}
    }, 0);
  }

  /** Short pulse on a button press. */
  buttonPulse() {
    if (!this.supported) return;
    if (!this.settings.haptics.buttonVibrate) return;
    // Throttle: a stream of presses must not vibrate continuously.
    const now = performance.now();
    if (now - this._lastButtonTime < 40) return;
    this._lastButtonTime = now;
    this._vibrate(Math.max(10, this.settings.haptics.buttonVibrateMs || 18));
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
        this._lastVib = 0;
        this._vibrate(0);
      }
      return;
    }
    const now = performance.now();
    // The protocol keeps re-sending the same rumble state; only re-trigger
    // when the magnitude meaningfully changes or enough time passed.
    if (Math.abs(mag - this._lastVib) < 24 && now - this._lastRumbleTime < 120) return;
    this._lastVib = mag;
    this._lastRumbleTime = now;
    this._vibrate(90);
  }

  stop() {
    if (!this.supported) return;
    this._lastVib = 0;
    this._vibrate(0);
  }
}
