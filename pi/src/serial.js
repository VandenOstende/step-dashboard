"use strict";
/**
 * Serieele poort zonder npm-afhankelijkheden.
 *
 * De VESC meldt zich via USB als een CDC-ACM apparaat (/dev/ttyACM0). Voor
 * zo'n virtuele poort is de baudrate betekenisloos — de USB-bulk-endpoints
 * bepalen de snelheid — dus het enige dat echt moet gebeuren is de tty in
 * raw-modus zetten. Dat doet `stty`, dat op Raspberry Pi OS in coreutils zit.
 *
 * Daarna is het apparaat gewoon een bestand: lezen en schrijven met fs.
 * Zo blijft de Pi volledig offline installeerbaar (geen `npm install`).
 */

const fs = require("fs");
const { execFile } = require("child_process");
const { EventEmitter } = require("events");

const READ_SIZE = 4096;

function stty(path, baud) {
  return new Promise((resolve, reject) => {
    execFile(
      "stty",
      ["-F", path, "raw", "-echo", "-echoe", "-echok", "-crtscts", "-ixon", "-ixoff",
        "min", "0", "time", "1", String(baud)],
      (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())
    );
  });
}

/** Zoek een aangesloten VESC. Voorkeur voor het geconfigureerde pad. */
function findPort(preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  let entries = [];
  try {
    entries = fs.readdirSync("/dev");
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (/^ttyACM\d+$/.test(name) || /^ttyUSB\d+$/.test(name)) candidates.push("/dev/" + name);
  }
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
      return p;
    } catch {
      /* volgende kandidaat */
    }
  }
  return null;
}

/**
 * Open de poort. Emits "data" (Buffer), "close" en "error".
 * Sluit zichzelf bij een leesfout — de aanroeper opent gewoon opnieuw.
 */
class SerialPort extends EventEmitter {
  constructor(path, fd) {
    super();
    this.path = path;
    this.fd = fd;
    this.closed = false;
    this.buf = Buffer.allocUnsafe(READ_SIZE);
    this._read();
  }

  static async open(path, baud) {
    await stty(path, baud);
    // Bewust fs.open met callback en niet fs.promises.open: die laatste geeft
    // een FileHandle terug, en zodra dat object opgeruimd wordt sluit Node de
    // onderliggende fd — midden in een lopende lezing. Een kale fd heeft die
    // koppeling niet.
    const fd = await new Promise((resolve, reject) => {
      fs.open(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY, (err, f) => (err ? reject(err) : resolve(f)));
    });
    return new SerialPort(path, fd);
  }

  _read() {
    if (this.closed) return;
    fs.read(this.fd, this.buf, 0, READ_SIZE, null, (err, bytes) => {
      if (this.closed) return;
      if (err) {
        // EAGAIN kan voorkomen als de driver even niets heeft; gewoon opnieuw.
        if (err.code === "EAGAIN" || err.code === "EINTR") {
          setTimeout(() => this._read(), 5);
          return;
        }
        this.close(err);
        return;
      }
      if (bytes > 0) this.emit("data", Buffer.from(this.buf.subarray(0, bytes)));
      // `stty min 0 time 1` laat read() na 100 ms met 0 bytes terugkomen, dus
      // deze lus draait niet heet en blokkeert nooit permanent een
      // threadpool-slot.
      setImmediate(() => this._read());
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("poort gesloten"));
      fs.write(this.fd, data, 0, data.length, null, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(err) {
    if (this.closed) return;
    this.closed = true;
    fs.close(this.fd, () => {});
    if (err) this.emit("error", err);
    this.emit("close");
  }
}

module.exports = { SerialPort, findPort };
