import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PROFILES, describeIr, encodeIr, type Btn, type Group, type IrCode, type IrNec, type Profile } from './protocols';
import IrScan from './IrScan';
import IrWizard from './IrWizard';
import { connectSerial, detect, disconnectSerial, readSerial, sendIr, sendSerial, watch, type Hw } from './transport';

const STORE = 'nxr.profiles.v1';
const GROUPS: Group[] = ['power', 'source', 'nav', 'volume'];
type Link = 'rs232' | 'ir';
type Tab = 'remote' | 'wizard' | 'scan' | 'console' | 'profile';
type Dot = 'ok' | 'warn' | 'bad' | 'idle';
interface Check { state: 'idle' | 'busy' | 'ok' | 'silent' | 'noprobe' | 'fail'; text: string }

function load(): Profile[] {
  try { const s = localStorage.getItem(STORE); if (s) return JSON.parse(s); } catch { /* пусто */ }
  return DEFAULT_PROFILES;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>(load);
  const [activeId, setActiveId] = useState<string>(() => {
    const a = localStorage.getItem('nxr.active');
    return profiles.some((p) => p.id === a) ? (a as string) : profiles[0].id;
  });
  const [link, setLink] = useState<Link>(() => (localStorage.getItem('nxr.link') === 'ir' ? 'ir' : 'rs232'));
  const [tab, setTab] = useState<Tab>('remote');
  const [log, setLog] = useState<{ t: string; text: string; err?: boolean }[]>([]);
  const [hw, setHw] = useState<Hw | null>(null);
  const [check, setCheck] = useState<Check>({ state: 'idle', text: 'Не проверялось' });
  const [raw, setRaw] = useState('');
  const [draft, setDraft] = useState('');
  const first = useRef(!localStorage.getItem('nxr.link')); // уже выбирали интерфейс — не переопределять
  const busy = useRef(false);
  const userClosed = useRef(false);

  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0];
  useEffect(() => { setDraft(JSON.stringify(profile, null, 2)); }, [profile]);
  // запоминаем выбранную доску и интерфейс: при следующем запуске пульт откроется сразу на них
  useEffect(() => { localStorage.setItem('nxr.active', activeId); }, [activeId]);
  useEffect(() => { localStorage.setItem('nxr.link', link); }, [link]);

  const say = (text: string, err = false) =>
    setLog((l) => [{ t: new Date().toLocaleTimeString('ru'), text, err }, ...l].slice(0, 100));

  // ---- автоопределение интерфейсов: при старте, по событиям USB, при возврате в приложение и раз в 3 с
  const refresh = useCallback(async () => {
    try { setHw(await detect()); } catch (e) { say('Определение интерфейсов: ' + errText(e), true); }
  }, []);
  useEffect(() => {
    refresh();
    const off = watch(refresh);
    const t = setInterval(refresh, 3000);
    return () => { off(); clearInterval(t); };
  }, [refresh]);

  // при первом определении выбираем подходящий интерфейс
  useEffect(() => {
    if (!hw || !first.current) return;
    first.current = false;
    if (!hw.adapters.length && !hw.webPorts && hw.ir) setLink('ir');
  }, [hw]);

  const connect = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; userClosed.current = false;
    try {
      const name = await connectSerial(profile.serial);
      const s = profile.serial;
      say(`Подключено: ${name} · ${s.baud} ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}`);
    } catch (e) { say(errText(e), true); }
    finally { busy.current = false; refresh(); }
  }, [profile, refresh]);

  const disconnect = async () => {
    userClosed.current = true;
    try { await disconnectSerial(); say('Порт закрыт'); } catch (e) { say(errText(e), true); }
    setCheck({ state: 'idle', text: 'Не проверялось' });
    refresh();
  };

  // авто-подключение в APK: нашли адаптер → запрашиваем разрешение USB и открываем порт
  useEffect(() => {
    if (hw?.native && link === 'rs232' && hw.adapters.length && !hw.open && !userClosed.current) connect();
  }, [hw, link, connect]);

  // порт пропал (адаптер выдернули) — сбросить результат проверки
  useEffect(() => { if (hw && !hw.open) setCheck((c) => (c.state === 'idle' ? c : { state: 'idle', text: 'Не проверялось' })); }, [hw?.open]);

  // ---- проверка соединения
  const runCheck = async () => {
    setCheck({ state: 'busy', text: 'Проверяю…' });
    try {
      if (link === 'ir') {
        const h = await detect();
        setCheck(h.ir
          ? { state: 'ok', text: 'ИК-излучатель работает. Принятие сигнала доской приложение подтвердить не может — проверьте по реакции.' }
          : { state: 'fail', text: h.native ? 'На этом телефоне нет ИК-излучателя.' : 'ИК доступен только в APK.' });
        return;
      }
      if (!(await detect()).open) await connectSerial(profile.serial);
      if (!profile.probe) {
        setCheck({ state: 'noprobe', text: 'Порт открыт и принимает данные. Ответ доски проверить нельзя: в профиле нет поля probe (команда-запрос).' });
        return;
      }
      const sent = await sendSerial(profile.probe);
      const r = await readSerial(1500);
      say(`Проверка: ${sent} → ${r || 'тишина'}`, !r);
      setCheck(r
        ? { state: 'ok', text: 'Доска ответила: ' + r }
        : { state: 'silent', text: 'Ответа нет. Проверьте кабель (попробуйте нуль-модем), скорость и ID доски.' });
    } catch (e) { setCheck({ state: 'fail', text: errText(e) }); }
    finally { refresh(); }
  };

  const press = async (b: Btn) => {
    navigator.vibrate?.(15);
    try {
      if (link === 'rs232') {
        if (!b.hex) throw new Error(`Для «${b.label}» нет HEX-команды`);
        say(`RS232 ← ${b.label}: ${await sendSerial(b.hex)}`);
      } else {
        if (!b.ir) throw new Error(`Для «${b.label}» нет ИК-кода`);
        const { freq, pattern } = encodeIr(b.ir, profile.irFreq);
        await sendIr(freq, pattern);
        say(`ИК ← ${b.label}: ${describeIr(b.ir)}`);
      }
    } catch (e) { say(errText(e), true); refresh(); }
  };

  const saveProfile = () => {
    try {
      const p: Profile = JSON.parse(draft);
      const next = profiles.some((x) => x.id === p.id) ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p];
      setProfiles(next); setActiveId(p.id);
      localStorage.setItem(STORE, JSON.stringify(next));
      say('Профиль сохранён');
    } catch (e) { say('Ошибка JSON: ' + errText(e), true); }
  };
  const saveBoard = (name: string, buttonId: string, code: IrNec) => {
    const base = DEFAULT_PROFILES[0];
    const p: Profile = {
      ...base,
      id: 'board-' + Date.now(),
      name,
      note: `Найдено ИК-мастером: ${describeIr(code)}. Остальные кнопки найдите во вкладке «Подбор» — протокол и адрес уже подставлены.`,
      irDefault: { proto: code.proto ?? 'nec', address: code.address, ext: code.ext },
      buttons: base.buttons.map((b) => (b.id === buttonId ? { ...b, ir: code } : b)),
    };
    const next = [...profiles, p];
    setProfiles(next);
    localStorage.setItem(STORE, JSON.stringify(next));
    setActiveId(p.id); setLink('ir'); setTab('remote');
    say(`Доска «${name}» сохранена и будет открываться по умолчанию`);
  };
  const assignIr = (id: string, ir: IrCode) => {
    const p: Profile = { ...profile, buttons: profile.buttons.map((b) => (b.id === id ? { ...b, ir } : b)) };
    const next = profiles.map((x) => (x.id === p.id ? p : x));
    setProfiles(next);
    localStorage.setItem(STORE, JSON.stringify(next));
    say(`Код ${describeIr(ir)} сохранён для «${profile.buttons.find((b) => b.id === id)?.label}»`);
  };
  const resetProfiles = () => {
    localStorage.removeItem(STORE); setProfiles(DEFAULT_PROFILES); setActiveId(DEFAULT_PROFILES[0].id); say('Профили сброшены');
  };

  useEffect(() => { if (link !== 'ir' && (tab === 'scan' || tab === 'wizard')) setTab('remote'); }, [link, tab]);

  // ---- статус
  const s = profile.serial;
  const rows: { k: string; dot: Dot; v: string }[] = [];
  if (hw) {
    const a = hw.adapters[0];
    rows.push({
      k: 'Адаптер RS232',
      dot: hw.native ? (a ? 'ok' : 'bad') : hw.serialApi ? 'ok' : 'bad',
      v: hw.native
        ? (a ? a.name : hw.usbHost ? 'не найден — подключите через OTG' : 'USB Host не поддерживается телефоном')
        : hw.serialApi ? `Web Serial доступен${hw.webPorts ? `, портов: ${hw.webPorts}` : ''}` : 'браузер без Web Serial — нужен APK',
    });
    rows.push({ k: 'Порт', dot: hw.open ? 'ok' : 'idle', v: hw.open ? `открыт · ${s.baud} ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits}` : 'закрыт' });
    const cd: Dot = { idle: 'idle', busy: 'warn', ok: 'ok', silent: 'bad', noprobe: 'warn', fail: 'bad' }[check.state] as Dot;
    rows.push({ k: 'Доска (RS232)', dot: cd, v: check.text });
    rows.push({ k: 'ИК-излучатель', dot: hw.ir ? 'ok' : hw.native ? 'bad' : 'idle', v: hw.ir ? 'есть' : hw.native ? 'нет на этом телефоне' : 'только в APK' });
  }
  const ready = hw ? (link === 'rs232' ? hw.open : hw.ir) : false;

  const has = (b: Btn) => (link === 'rs232' ? !!b.hex : !!b.ir);

  return (
    <div className="app">
      <header>
        <select value={profile.id} onChange={(e) => setActiveId(e.target.value)} aria-label="Профиль">
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="seg">
          {(['rs232', 'ir'] as Link[]).map((l) => (
            <button key={l} className={link === l ? 'on' : ''} onClick={() => setLink(l)}>{l === 'rs232' ? 'RS232' : 'ИК'}</button>
          ))}
        </div>
      </header>

      <section className="status" aria-live="polite">
        <div className={'pill ' + (ready ? 'ok' : 'bad')}>
          <i className="dot" />{!hw ? 'Определяю интерфейсы…' : ready ? 'Готов к отправке' : link === 'rs232' ? 'Порт не подключён' : 'ИК недоступен'}
        </div>
        <ul>
          {rows.map((r) => (
            <li key={r.k} className={link === 'ir' && r.k.includes('RS232') || link === 'rs232' && r.k.startsWith('ИК') ? 'dim' : ''}>
              <i className={'dot ' + r.dot} /><b>{r.k}</b><span>{r.v}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          {link === 'rs232' && (
            <button className="sm" onClick={hw?.open ? disconnect : connect} disabled={!hw || (hw.native && !hw.adapters.length && !hw.open)}>
              {hw?.open ? 'Отключить' : 'Подключить'}
            </button>
          )}
          <button className="sm primary" onClick={runCheck} disabled={!hw || check.state === 'busy'}>Проверить связь</button>
        </div>
      </section>

      {profile.note && <p className="note">{profile.note}</p>}

      <main>
        {tab === 'remote' && GROUPS.map((g) => (
          <section key={g} className={'grp ' + g}>
            {profile.buttons.filter((b) => b.group === g).map((b) => (
              <button key={b.id} className={'key k-' + b.id} style={{ gridArea: g === 'nav' ? b.id : undefined }}
                disabled={!has(b)} onClick={() => press(b)}>{b.label}</button>
            ))}
          </section>
        ))}

        {tab === 'wizard' && (
          <IrWizard buttons={DEFAULT_PROFILES[0].buttons} freq={profile.irFreq} ready={!!hw?.ir} onSaved={saveBoard} say={say} />
        )}

        {tab === 'scan' && (
          <IrScan buttons={profile.buttons} freq={profile.irFreq} ready={!!hw?.ir} onAssign={assignIr} say={say} initial={profile.irDefault} />
        )}

        {tab === 'console' && (
          <div className="pane">
            {link === 'rs232' && (
              <form onSubmit={(e) => { e.preventDefault(); sendSerial(raw).then((h) => say('RS232 ← ' + h)).catch((x) => { say(errText(x), true); refresh(); }); }}>
                <input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="HEX, например FF 06 41 82 44 11" />
                <button className="send">Отправить</button>
              </form>
            )}
            <ul className="log">
              {log.map((l, i) => <li key={i} className={l.err ? 'err' : ''}><time>{l.t}</time> {l.text}</li>)}
              {!log.length && <li>Здесь появятся отправленные команды и ошибки.</li>}
            </ul>
          </div>
        )}

        {tab === 'profile' && (
          <div className="pane">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
            <div className="row">
              <button className="send" onClick={saveProfile}>Сохранить</button>
              <button onClick={resetProfiles}>Сбросить всё</button>
            </div>
          </div>
        )}
      </main>

      {tab === 'remote' && log[0] && <p className={'last' + (log[0].err ? ' err' : '')}>{log[0].text}</p>}
      <nav>
        {([['remote', 'Пульт'], ['wizard', 'Мастер'], ['scan', 'Подбор'], ['console', 'Консоль'], ['profile', 'Профиль']] as [Tab, string][])
          .filter(([t]) => (t !== 'scan' && t !== 'wizard') || link === 'ir').map(([t, n]) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{n}</button>
        ))}
      </nav>
    </div>
  );
}
