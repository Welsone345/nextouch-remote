import { useEffect, useRef, useState } from 'react';
import { describeIr, encodeIr, type Btn, type IrCode, type IrNec } from './protocols';
import { sendIr } from './transport';

interface Props {
  buttons: Btn[];
  freq: number;
  ready: boolean;
  onAssign: (buttonId: string, code: IrCode) => void;
  say: (text: string, err?: boolean) => void;
  initial?: { proto?: 'nec' | 'samsung'; address: number; ext?: boolean };
}

const num = (s: string, max: number) => Math.min(max, Math.max(0, parseInt(s, 16) || 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Перебор NEC-команд: телефон шлёт коды по очереди, вы смотрите на доску. */
export default function IrScan({ buttons, freq, ready, onAssign, say, initial }: Props) {
  const [addr, setAddr] = useState(initial ? h2(initial.address) : '00');
  const [from, setFrom] = useState('00');
  const [to, setTo] = useState('FF');
  const [delay, setDelay] = useState(900);
  const [ext, setExt] = useState(!!initial?.ext);
  const [proto, setProto] = useState<'nec' | 'samsung'>(initial?.proto ?? 'nec');
  const [target, setTarget] = useState(buttons[0]?.id ?? '');
  const [running, setRunning] = useState(false);
  const [cur, setCur] = useState<IrNec | null>(null);
  const stop = useRef(true);
  const pos = useRef(-1);

  useEffect(() => () => { stop.current = true; }, []);

  const send = async (command: number) => {
    const code: IrNec = { address: num(addr, ext ? 0xffff : 0xff), command, ext, proto };
    const { freq: f, pattern } = encodeIr(code, freq);
    await sendIr(f, pattern);
    pos.current = command;
    setCur(code);
  };

  const start = async () => {
    const lo = num(from, 255), hi = num(to, 255);
    stop.current = false; setRunning(true);
    let c = pos.current >= lo && pos.current < hi ? pos.current + 1 : lo;
    try {
      while (!stop.current && c <= hi) { await send(c); await sleep(delay); c++; }
      if (!stop.current) say('Диапазон команд пройден');
    } catch (e) { say(e instanceof Error ? e.message : String(e), true); }
    stop.current = true; setRunning(false);
  };
  const pause = () => { stop.current = true; };
  const reset = () => { stop.current = true; pos.current = -1; setCur(null); };
  const step = async (d: number) => {
    const c = Math.min(255, Math.max(0, (pos.current < 0 ? num(from, 255) : pos.current) + d));
    try { await send(c); } catch (e) { say(e instanceof Error ? e.message : String(e), true); }
  };
  const worked = () => {
    stop.current = true;
    if (cur && target) onAssign(target, cur);
  };

  return (
    <div className="pane scan">
      {!ready && <p className="warn">ИК-излучатель недоступен: подбор работает только в APK на телефоне с ИК-портом.</p>}
      <p className="note">
        Направьте ИК-окно телефона на датчик доски (обычно на передней рамке), расстояние до 2–3 м. Выберите кнопку, нажмите «Старт»
        и следите за доской. Когда она среагирует, нажмите «Сработало!» — последний отправленный код сохранится.
        Если реакция запоздала, вернитесь на шаг ◀ и проверьте.
      </p>
      <div className="grid2">
        <label>Кнопка<select value={target} onChange={(e) => setTarget(e.target.value)}>
          {buttons.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>
        <label>Адрес (hex)<input value={addr} onChange={(e) => setAddr(e.target.value)} /></label>
        <label>Команды от (hex)<input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>до (hex)<input value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Пауза, мс<input type="number" min={300} max={3000} step={100} value={delay} onChange={(e) => setDelay(+e.target.value)} /></label>
        <label>Протокол<select value={proto} onChange={(e) => setProto(e.target.value as 'nec' | 'samsung')}>
          <option value="nec">NEC</option><option value="samsung">Samsung32</option></select></label>
        <label className="chk"><input type="checkbox" checked={ext} onChange={(e) => setExt(e.target.checked)} />16-бит адрес (ext)</label>
      </div>
      <div className="cur">{cur ? describeIr(cur) : '—'}</div>
      <div className="row">
        <button onClick={() => step(-1)} disabled={!ready || running}>◀</button>
        {running
          ? <button className="send" onClick={pause}>Пауза</button>
          : <button className="send" onClick={start} disabled={!ready}>Старт</button>}
        <button onClick={() => step(1)} disabled={!ready || running}>▶</button>
        <button onClick={reset}>Сброс</button>
      </div>
      <button className="found" onClick={worked} disabled={!cur}>Сработало! Сохранить для кнопки</button>
    </div>
  );
}
