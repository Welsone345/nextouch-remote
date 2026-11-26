import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { bytesToHex, hexToBytes, type SerialCfg } from './protocols';

export interface Adapter { id: number; name: string; permission: boolean }
interface RemotePlugin {
  getStatus(): Promise<{ ir: boolean; usbHost: boolean; devices: Adapter[]; open: boolean }>;
  transmitIr(o: { frequency: number; pattern: number[] }): Promise<void>;
  openSerial(o: { deviceId: number } & SerialCfg): Promise<void>;
  writeSerial(o: { hex: string }): Promise<void>;
  readSerial(o: { timeout: number }): Promise<{ hex: string }>;
  closeSerial(): Promise<void>;
  addListener(ev: 'usb', cb: () => void): Promise<PluginListenerHandle>;
}
const Native = registerPlugin<RemotePlugin>('Remote');
export const isNative = Capacitor.isNativePlatform();

/** Что найдено на устройстве прямо сейчас */
export interface Hw {
  native: boolean;
  ir: boolean;
  usbHost: boolean;
  serialApi: boolean; // Web Serial (в браузере)
  adapters: Adapter[]; // USB-RS232 адаптеры (APK)
  webPorts: number; // уже разрешённые порты (браузер)
  open: boolean;
}

let port: SerialPort | undefined;
let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let rx: number[] = [];

export async function detect(): Promise<Hw> {
  if (isNative) {
    const s = await Native.getStatus();
    return { native: true, ir: s.ir, usbHost: s.usbHost, serialApi: true, adapters: s.devices, webPorts: 0, open: s.open };
  }
  const has = 'serial' in navigator;
  return {
    native: false, ir: false, usbHost: false, serialApi: has, adapters: [],
    webPorts: has ? (await navigator.serial.getPorts()).length : 0, open: !!writer,
  };
}

/** Подписка на подключение/отключение. Возвращает функцию отписки. */
export function watch(cb: () => void): () => void {
  const offs: (() => void)[] = [];
  const onVis = () => { if (!document.hidden) cb(); };
  document.addEventListener('visibilitychange', onVis);
  offs.push(() => document.removeEventListener('visibilitychange', onVis));
  if (isNative) {
    const h = Native.addListener('usb', cb);
    offs.push(() => { h.then((x) => x.remove()); });
  } else if ('serial' in navigator) {
    navigator.serial.addEventListener('connect', cb);
    navigator.serial.addEventListener('disconnect', cb);
    offs.push(() => {
      navigator.serial.removeEventListener('connect', cb);
      navigator.serial.removeEventListener('disconnect', cb);
    });
  }
  return () => offs.forEach((f) => f());
}

export async function connectSerial(cfg: SerialCfg): Promise<string> {
  if (isNative) {
    const { devices } = await Native.getStatus();
    if (!devices.length) throw new Error('USB-RS232 адаптер не найден. Нужен OTG-кабель и адаптер.');
    await Native.openSerial({ deviceId: devices[0].id, ...cfg }); // тут Android спросит доступ к USB
    return devices[0].name;
  }
  if (!('serial' in navigator)) throw new Error('Web Serial в этом браузере недоступен.');
  const known = await navigator.serial.getPorts();
  port = known[0] ?? (await navigator.serial.requestPort());
  await port.open({ baudRate: cfg.baud, dataBits: cfg.dataBits, stopBits: cfg.stopBits, parity: cfg.parity });
  writer = port.writable!.getWriter();
  reader = port.readable!.getReader();
  rx = [];
  (async () => { // фоновое чтение, чтобы можно было ждать ответ доски
    try { for (;;) { const { value, done } = await reader!.read(); if (done) break; if (value) rx.push(...value); } }
    catch { /* порт отключён */ }
  })();
  return 'Web Serial';
}

export async function disconnectSerial() {
  if (isNative) return Native.closeSerial();
  try { await reader?.cancel(); reader?.releaseLock(); writer?.releaseLock(); await port?.close(); } catch { /* уже закрыт */ }
  reader = writer = port = undefined;
}

export async function sendSerial(hex: string): Promise<string> {
  const bytes = hexToBytes(hex);
  if (isNative) await Native.writeSerial({ hex: bytesToHex(bytes) });
  else {
    if (!writer) throw new Error('Порт не подключён.');
    rx = [];
    await writer.write(bytes);
  }
  return bytesToHex(bytes);
}

/** Ждёт ответ доски до timeout мс. Пустая строка — ответа нет. */
export async function readSerial(timeout: number): Promise<string> {
  if (isNative) return (await Native.readSerial({ timeout })).hex;
  const end = Date.now() + timeout;
  while (!rx.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100)); // дождаться хвоста ответа
  const out = Uint8Array.from(rx); rx = [];
  return out.length ? bytesToHex(out) : '';
}

export async function sendIr(frequency: number, pattern: number[]) {
  if (!isNative) throw new Error('ИК работает только в APK на телефоне с ИК-портом.');
  await Native.transmitIr({ frequency, pattern });
}
