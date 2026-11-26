export interface SerialCfg {
  baud: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
}
export type Group = 'power' | 'source' | 'nav' | 'volume';
/** Стандартный NEC: 8-битный адрес и 8-битная команда. Частота 38 кГц. */
export interface IrNec {
  address: number;
  command: number;
  /** true — «расширенный» NEC: 16-битный адрес без инверсии (часто у китайских пультов) */
  ext?: boolean;
  /** nec (по умолчанию) или samsung (Samsung32: заголовок 4500/4500, адрес дублируется) */
  proto?: 'nec' | 'samsung';
}
/** NEC, либо код Pronto («0000 006D ...»), либо сырые длительности в мкс (вкл, выкл, вкл, ...) */
export type IrCode = IrNec | { pronto: string } | { raw: number[]; freq?: number };
export interface Btn {
  id: string;
  label: string;
  group: Group;
  /** Команда RS232 в HEX, например "FF 06 41 82 44 11" */
  hex?: string;
  ir?: IrCode;
}
export interface Profile {
  id: string;
  name: string;
  note: string;
  serial: SerialCfg;
  irFreq: number;
  /** Протокол и адрес, найденные ИК-мастером; подставляются в «Подбор» */
  irDefault?: { proto?: 'nec' | 'samsung'; address: number; ext?: boolean };
  /** Необязательная HEX-команда-запрос (например, «статус питания»). Если доска на неё отвечает — связь подтверждена. */
  probe?: string;
  buttons: Btn[];
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/0x|[\s,:-]/gi, '');
  if (!clean || clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('Неверный HEX: ' + hex);
  return Uint8Array.from(clean.match(/../g)!.map((h) => parseInt(h, 16)));
}
export const bytesToHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();

/** NEC → массив длительностей в микросекундах (вкл, выкл, вкл, ...) для ConsumerIrManager */
export function encodeNec({ address, command, ext, proto }: IrNec): number[] {
  const samsung = proto === 'samsung';
  const bits: number[] = [];
  const push = (v: number) => { for (let i = 0; i < 8; i++) bits.push((v >> i) & 1); };
  push(address & 0xff);
  push(samsung ? address & 0xff : ext ? (address >> 8) & 0xff : ~address & 0xff);
  push(command & 0xff); push(~command & 0xff);
  const p = samsung ? [4500, 4500] : [9000, 4500];
  for (const b of bits) p.push(560, b ? 1690 : 560);
  p.push(560);
  return p;
}

/** Pronto Hex → частота и длительности в мкс */
export function parsePronto(s: string): { freq: number; pattern: number[] } {
  const w = s.trim().split(/\s+/).map((x) => parseInt(x, 16));
  if (w.length < 6 || w.some(Number.isNaN) || w[0] !== 0) throw new Error('Pronto: ожидается формат «0000 006D …»');
  const unit = w[1] * 0.241246;
  const pairs = w[2] > 0 ? w[2] : w[3];
  if (w.length < 4 + pairs * 2) throw new Error('Pronto: код обрезан');
  return { freq: Math.round(1e6 / unit), pattern: w.slice(4, 4 + pairs * 2).map((x) => Math.round(x * unit)) };
}

export function encodeIr(c: IrCode, defFreq = 38000): { freq: number; pattern: number[] } {
  if ('pronto' in c) return parsePronto(c.pronto);
  if ('raw' in c) return { freq: c.freq ?? defFreq, pattern: c.raw };
  return { freq: defFreq, pattern: encodeNec(c) };
}

export function describeIr(c: IrCode): string {
  if ('pronto' in c) return 'Pronto';
  if ('raw' in c) return `raw (${c.raw.length})`;
  const h = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `${c.proto === 'samsung' ? 'Samsung32' : 'NEC'}${c.ext ? ' ext' : ''} ${h(c.address)}/${h(c.command)}`;
}

const layout: [string, string, Group][] = [
  ['poweron', 'Включить', 'power'], ['poweroff', 'Выключить', 'power'],
  ['hdmi1', 'HDMI 1', 'source'], ['hdmi2', 'HDMI 2', 'source'],
  ['vga', 'VGA', 'source'], ['ops', 'ПК (OPS)', 'source'],
  ['menu', 'Меню', 'nav'], ['up', '▲', 'nav'], ['back', 'Назад', 'nav'],
  ['left', '◀', 'nav'], ['ok', 'OK', 'nav'], ['right', '▶', 'nav'], ['down', '▼', 'nav'],
  ['voldown', 'Гр. −', 'volume'], ['mute', 'Звук выкл.', 'volume'], ['volup', 'Гр. +', 'volume'],
];

/**
 * Протокол Nextouch в открытых руководствах не опубликован — все коды пустые.
 * Заполните их по документации производителя (support: 8 800 700-2018) или
 * подберите в консоли, затем они сохранятся на телефоне.
 */
const nextouch: Profile = {
  id: 'nextouch',
  name: 'Nextouch (заполнить коды)',
  note: 'Коды не опубликованы. Для ИК: нажмите «ИК-подбор» и найдите код перебором, либо впишите NEC / Pronto / raw во вкладке «Профиль».',
  serial: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
  irFreq: 38000,
  buttons: layout.map(([id, label, group]) => ({ id, label, group })),
};

/** Реальные команды из открытой спецификации Allsee Touch Screen 3188 — только чтобы проверить линию. */
const allsee: Profile = {
  id: 'allsee3188',
  name: 'Allsee 3188 (проверка линии)',
  note: 'Чужой протокол из открытой спецификации. На Nextouch может не сработать — нужен, чтобы убедиться, что адаптер и кабель живы.',
  serial: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
  irFreq: 38000,
  buttons: [
    { id: 'poweron', label: 'Включить', group: 'power', hex: '01 30 2A 30 41 30 43 02 43 32 30 33 44 36 30 30 30 31 03 18 0D' },
    { id: 'poweroff', label: 'Выключить', group: 'power', hex: '01 30 2A 30 41 30 43 02 43 32 30 33 44 36 30 30 30 34 03 1D 0D' },
    { id: 'hdmi1', label: 'HDMI', group: 'source', hex: 'FF 06 41 82 44 11' },
    { id: 'vga', label: 'VGA', group: 'source', hex: 'FF 06 41 A2 44 11' },
    { id: 'ops', label: 'ПК (OPS)', group: 'source', hex: 'FF 06 41 E2 44 11' },
  ],
};

export const DEFAULT_PROFILES: Profile[] = [nextouch, allsee];
