// Применяет к сгенерированной папке android/ всё, что нужно приложению. Можно запускать повторно.
import fs from 'node:fs';
import path from 'node:path';

const A = 'android';
if (!fs.existsSync(A)) throw new Error('Нет папки android/. Сначала: npx cap add android');

const patch = (file, marker, fn) => {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(marker)) return console.log('уже применено:', file);
  const out = fn(s);
  if (out === s) throw new Error('Не удалось пропатчить ' + file);
  fs.writeFileSync(file, out); console.log('обновлено:', file);
};

// 1. Java-код плагина и MainActivity
const dir = path.join(A, 'app/src/main/java/ru/nextouch/remote');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync('native/android').filter((x) => x.endsWith('.java')))
  fs.copyFileSync(path.join('native/android', f), path.join(dir, f));
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.kt'))) fs.rmSync(path.join(dir, f));

// 2. jitpack (библиотека usb-serial-for-android)
patch(path.join(A, 'build.gradle'), 'jitpack.io', (s) =>
  s.replace(/allprojects\s*\{\s*repositories\s*\{/, (m) => m + "\n        maven { url 'https://jitpack.io' }"));

// 3. зависимость
patch(path.join(A, 'app/build.gradle'), 'usb-serial-for-android', (s) =>
  s.replace(/dependencies\s*\{/, (m) => m + "\n    implementation 'com.github.mik3y:usb-serial-for-android:3.8.1'"));

// 4. разрешения и возможности
patch(path.join(A, 'app/src/main/AndroidManifest.xml'), 'TRANSMIT_IR', (s) =>
  s.replace('<application', `<uses-permission android:name="android.permission.TRANSMIT_IR" />
    <uses-feature android:name="android.hardware.consumerir" android:required="false" />
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <application`));
