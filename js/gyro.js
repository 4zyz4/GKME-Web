// GKME-Web — gyroscope / accelerometer input via DeviceMotion.
//
// The phone's sensors are reported verbatim to the host, which feeds them into
// the emulated controller's *native* gyro/accel lane. No mouse/stick remapping
// happens on the web side.
//
// Requires a secure context (HTTPS or localhost) and, on iOS, an explicit
// user-granted permission.

const DEG2RAD = Math.PI / 180;
const G = 9.80665;

export class Gyro {
  constructor() {
    this.enabled = false;
    this.permissionGranted = false;
    this.supported = typeof window !== "undefined" && "DeviceMotionEvent" in window;
    this.gyroX = 0;
    this.gyroY = 0;
    this.gyroZ = 0;
    this.accelX = 0;
    this.accelY = 0;
    this.accelZ = 0;

    this._onMotion = this._onMotion.bind(this);
  }

  static needsPermission() {
    return (
      typeof window !== "undefined" &&
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    );
  }

  async requestPermission() {
    if (!Gyro.needsPermission()) {
      this.permissionGranted = true;
      return true;
    }
    try {
      const res = await DeviceMotionEvent.requestPermission();
      this.permissionGranted = res === "granted";
      return this.permissionGranted;
    } catch {
      return false;
    }
  }

  async start() {
    if (!this.supported) return false;
    if (Gyro.needsPermission() && !this.permissionGranted) {
      const ok = await this.requestPermission();
      if (!ok) return false;
    }
    if (!this.enabled) {
      window.addEventListener("devicemotion", this._onMotion, { passive: true });
      this.enabled = true;
    }
    return true;
  }

  stop() {
    if (this.enabled) {
      window.removeEventListener("devicemotion", this._onMotion);
      this.enabled = false;
    }
    this.zero();
  }

  zero() {
    this.gyroX = this.gyroY = this.gyroZ = 0;
    this.accelX = this.accelY = this.accelZ = 0;
  }

  _onMotion(e) {
    const rr = e.rotationRate;
    if (rr) {
      // rotationRate is deg/s → rad/s.
      this.gyroX = (rr.beta || 0) * DEG2RAD;
      this.gyroY = (rr.gamma || 0) * DEG2RAD;
      this.gyroZ = (rr.alpha || 0) * DEG2RAD;
    }
    const acc = e.accelerationIncludingGravity || e.acceleration;
    if (acc) {
      const scale = e.accelerationIncludingGravity ? G : 1;
      this.accelX = (acc.x || 0) * scale;
      this.accelY = (acc.y || 0) * scale;
      this.accelZ = (acc.z || 0) * scale;
    }
  }
}
