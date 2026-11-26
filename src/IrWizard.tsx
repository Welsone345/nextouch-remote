import { useEffect, useRef, useState } from 'react';
import { describeIr, encodeIr, type Btn, type IrNec } from './protocols';
import { sendIr } from './transport';

interface Props {
  buttons: Btn[];
  freq: number;
  ready: boolean;
  onSaved: (boardName: string, buttonId: string, code: IrNec) => void;
  say: (text: string, err?: boolean) => void;
}

/** Типичные ИК-схемы пультов ТВ/панелей. Для Nextouch они НЕ проверены — это варианты для перебора. */
const VARIANTS: { label: string; proto: 'nec' | 'samsung'; address: number; ext?: boolean }[] = [
  { label: 'NEC · адрес 00', proto: 'nec', address: 0x00 },
  { label: 'NEC · адрес 04', proto: 'nec', address: 0x04 },
  { label: 'NEC · адрес 40', proto: 'nec', address: 0x40 },
  { label: 'NEC · адрес 01', proto: 'nec', address: 0x01 },
  { label: 'Samsung32 · адрес 07', proto: 'samsung', address: 0x07 },
  { label: 'NEC ext (16 бит) · адрес 00FF', proto: 'nec', address: 0x00ff, ext: true },
];

/** Известные коды питания популярных ТВ (как в приложениях-пультах). Для Nextouch не проверены. */
const POPULAR: IrNec[] = [
  { proto: 'nec', address: 0x04, command: 0x08 }, // LG
  { proto: 'samsung', address: 0x07, command: 0x02 }, // Samsung
  { proto: 'nec', address: 0x40, command: 0x12 }, // Toshiba
];

type Step = 'intro' | 'run' | 'refine' | 'ask' | 'name' | 'none';
const LAG_MS = 2500; // за сколько секунд до нажатия «среагировала» искать нужный код
const FRAME_MS = 70; // примерная длительность одного ИК-кадра (для оценки времени)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * Все варианты пробуются одновременно: для каждой команды 00–FF подряд идут кадры всех вариантов.
 * Когда доска среагировала, нужный код ищется делением пополам (несколько «да/нет»).
 */
export default function IrWizard({ buttons, freq, ready, onSaved, say }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [cmd, setCmd] = useState(0);
  const [gap, setGap] = useState(40);
  const [cur, setCur] = useState<IrNec | null>(null);
  const [cand, setCand] = useState<IrNec[]>([]);
  const [half, setHalf] = useState<IrNec[]>([]);
  const [round, setRound] = useState(1);
  const [name, setName] = useState('');
  const [target, setTarget] = useState(buttons[0]?.id ?? '');
  const hist = useRef<{ code: IrNec; t: number }[]>([]);
  const lastC = useRef(-1);
  const stop = useRef(true);
  const gen = useRef(0);

  useEffect(() => () => { stop.current = true; gen.current++; }, []);

  const err = (e: unknown) => say(e instanceof Error ? e.message : String(e), true);
  const fire = async (code: IrNec) => {
    const { freq: f, pattern } = encodeIr(code, freq);
    await sendIr(f, pattern);
  };
  const estMin = (g: number, fromCmd = 0) => ((255 - fromCmd + 1) * VARIANTS.length * (g + FRAME_MS)) / 60000;

  const run = async (from: number) => {
    const id = ++gen.current;
    stop.current = false; setStep('run');
    try {
      if (from === 0) {
        for (const code of POPULAR) {
          if (stop.current || id !== gen.current) return;
          await fire(code);
          hist.current.push({ code, t: Date.now() });
          await sleep(gap);
        }
      }
      for (let c = from; c <= 255; c++) {
        lastC.current = c; setCmd(c);
        for (const v of VARIANTS) {
          if (stop.current || id !== gen.current) return;
          const code: IrNec = { proto: v.proto, address: v.address, ext: v.ext, command: c };
          await fire(code);
          hist.current.push({ code, t: Date.now() });
          if (hist.current.length > 400) hist.current.splice(0, 100);
          await sleep(gap);
        }
      }
    } catch (e) { err(e); setStep('intro'); return; }
    if (id === gen.current && !stop.current) { stop.current = true; setStep('none'); }
  };

  // половина кандидатов отправляется заново, пользователь отвечает, среагировала ли доска
  const probe = async (list: IrNec[]) => {
    if (list.length <= 1) { setCur(list[0] ?? null); setStep('ask'); return; }
    const a = list.slice(0, Math.ceil(list.length / 2));
    setHalf(a); setStep('refine');
    await sleep(600);
    try { for (const c of a) { await fire(c); await sleep(gap); } } catch (e) { err(e); }
  };

  const reacted = () => {
    stop.current = true; gen.current++;
    const now = Date.now();
    let list = hist.current.filter((h) => now - h.t <= LAG_MS).map((h) => h.code);
    if (list.length < VARIANTS.length) list = hist.current.slice(-2 * VARIANTS.length).map((h) => h.code);
    list = list.slice(-48);
    setCand(list); setRound(1); probe(list);
  };

  const answer = (yes: boolean) => {
    const next = yes ? half : cand.filter((c) => !half.includes(c));
    setCand(next); setRound((r) => r + 1); probe(next);
  };

  const pct = Math.round(((cmd + 1) / 256) * 100);
  const quick = Math.round((32 * VARIANTS.length * (gap + FRAME_MS)) / 1000);

  return (
    <div className="pane wiz">
      {!ready && <p className="warn">ИК-излучатель недоступен: мастер работает только в APK на телефоне с ИК-портом.</p>}

      {step === 'intro' && (<>
        <p className="note">
          Мастер пробует сразу {VARIANTS.length} вариантов ИК-подключения (NEC с адресами 00/04/40/01, Samsung32, NEC ext) и перебирает команды 00–FF.
          Направьте ИК-окно телефона на датчик доски (обычно на передней рамке), расстояние до 2–3 м.
          Как только доска что-то сделает (включится, мигнёт, откроется меню, изменится громкость), нажмите «Доска среагировала».
        </p>
        <p className="note">Сначала идут популярные коды питания, затем команды 00–1F (≈{quick} с), потом остальные.</p>
        <label className="fld">Режим
          <select value={gap} onChange={(e) => setGap(+e.target.value)}>
            <option value={40}>Быстро — полный перебор ≈ {estMin(40).toFixed(1).replace('.', ',')} мин</option>
            <option value={100}>Надёжнее — ≈ {estMin(100).toFixed(1).replace('.', ',')} мин</option>
          </select>
        </label>
        <button className="send big" onClick={() => run(0)} disabled={!ready}>Начать</button>
      </>)}

      {step === 'run' && (<>
        <div className="vtitle">Команда {h2(cmd)} из FF · все {VARIANTS.length} вариантов</div>
        <div className="bar"><i style={{ width: pct + '%' }} /></div>
        <p className="note">Осталось примерно {Math.max(0.1, estMin(gap, cmd + 1)).toFixed(1).replace('.', ',')} мин. Следите за доской.</p>
        <button className="found big" onClick={reacted}>Доска среагировала</button>
        <button className="big" onClick={() => { stop.current = true; gen.current++; setStep('intro'); }}>Остановить</button>
      </>)}

      {step === 'refine' && (<>
        <div className="vtitle">Уточняю код · раунд {round}</div>
        <p className="note">
          Отправил {half.length} из {cand.length} возможных кодов. Доска среагировала?
        </p>
        <button className="found big" onClick={() => answer(true)}>Да, среагировала</button>
        <button className="big" onClick={() => answer(false)}>Нет, не среагировала</button>
        <button className="big" onClick={() => probe(cand)}>Отправить ещё раз</button>
      </>)}

      {step === 'ask' && (<>
        <div className="vtitle">Удалось подключиться?</div>
        <p className="note">Найден код: <b>{cur ? describeIr(cur) : '—'}</b>. Нажмите «Отправить ещё раз» и убедитесь, что доска реагирует.</p>
        <button onClick={() => cur && fire(cur).catch(err)} disabled={!cur}>Отправить ещё раз</button>
        <button className="found big" onClick={() => setStep('name')} disabled={!cur}>Да, доска реагирует</button>
        <button className="big" onClick={() => run(lastC.current + 1)}>Нет — искать дальше</button>
      </>)}

      {step === 'name' && (<>
        <div className="vtitle">Как назвать доску?</div>
        <label className="fld">Название
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Nextouch 65 — каб. 12" autoFocus />
        </label>
        <label className="fld">Что сделала эта команда
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {buttons.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </label>
        <button className="send big" disabled={!name.trim() || !cur}
          onClick={() => cur && onSaved(name.trim(), target, cur)}>Сохранить и открыть пульт</button>
      </>)}

      {step === 'none' && (<>
        <div className="vtitle">Ничего не нашлось</div>
        <p className="note">
          Ни один из типовых вариантов не сработал. Попробуйте вкладку «Подбор» с другим адресом, впишите код вручную (NEC / Pronto / raw)
          во вкладке «Профиль» или снимите код с родного пульта ИК-приёмником.
        </p>
        <button className="send big" onClick={() => setStep('intro')}>Начать заново</button>
      </>)}
    </div>
  );
}
