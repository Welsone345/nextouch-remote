package ru.nextouch.remote;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.ConsumerIrManager;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;

@CapacitorPlugin(name = "Remote")
public class RemotePlugin extends Plugin {
    private static final String PERM = "ru.nextouch.remote.USB_PERMISSION";
    private UsbSerialPort port;

    private final BroadcastReceiver usbEvents = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(i.getAction())) closeQuietly();
            notifyListeners("usb", new JSObject());
        }
    };

    @Override public void load() {
        IntentFilter f = new IntentFilter();
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), usbEvents, f, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(usbEvents); } catch (Exception ignored) { }
        closeQuietly();
    }

    private UsbManager usb() { return (UsbManager) getContext().getSystemService(Context.USB_SERVICE); }
    private ConsumerIrManager ir() { return (ConsumerIrManager) getContext().getSystemService(Context.CONSUMER_IR_SERVICE); }
    private void closeQuietly() { try { if (port != null) port.close(); } catch (Exception ignored) { } port = null; }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSArray devs = new JSArray();
        for (UsbSerialDriver d : UsbSerialProber.getDefaultProber().findAllDrivers(usb())) {
            UsbDevice dev = d.getDevice();
            String name = (dev.getProductName() != null ? dev.getProductName() : "USB-serial")
                    + String.format(" (%04x:%04x)", dev.getVendorId(), dev.getProductId());
            devs.put(new JSObject().put("id", dev.getDeviceId()).put("name", name).put("permission", usb().hasPermission(dev)));
        }
        ConsumerIrManager m = ir();
        JSObject r = new JSObject();
        r.put("ir", m != null && m.hasIrEmitter());
        r.put("usbHost", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_USB_HOST));
        r.put("devices", devs);
        r.put("open", port != null);
        call.resolve(r);
    }

    @PluginMethod
    public void transmitIr(PluginCall call) {
        ConsumerIrManager m = ir();
        if (m == null || !m.hasIrEmitter()) { call.reject("На телефоне нет ИК-излучателя"); return; }
        JSArray arr = call.getArray("pattern");
        if (arr == null) { call.reject("Нет pattern"); return; }
        try {
            int[] p = new int[arr.length()];
            for (int i = 0; i < p.length; i++) p[i] = arr.getInt(i);
            m.transmit(call.getInt("frequency", 38000), p);
            call.resolve();
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    @PluginMethod
    public void openSerial(final PluginCall call) {
        Integer id = call.getInt("deviceId");
        UsbSerialDriver found = null;
        for (UsbSerialDriver d : UsbSerialProber.getDefaultProber().findAllDrivers(usb()))
            if (id != null && d.getDevice().getDeviceId() == id) found = d;
        if (found == null) { call.reject("Адаптер не найден"); return; }
        final UsbSerialDriver driver = found;
        if (usb().hasPermission(driver.getDevice())) { open(call, driver); return; }

        // Android покажет системный диалог «Разрешить приложению доступ к USB-устройству?»
        bridge.saveCall(call);
        BroadcastReceiver rec = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                getContext().unregisterReceiver(this);
                if (i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) open(call, driver);
                else call.reject("Доступ к USB-адаптеру не выдан");
                bridge.releaseCall(call);
            }
        };
        ContextCompat.registerReceiver(getContext(), rec, new IntentFilter(PERM), ContextCompat.RECEIVER_NOT_EXPORTED);
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        usb().requestPermission(driver.getDevice(),
                PendingIntent.getBroadcast(getContext(), 0, new Intent(PERM).setPackage(getContext().getPackageName()), flags));
    }

    private void open(PluginCall call, UsbSerialDriver driver) {
        try {
            UsbDeviceConnection conn = usb().openDevice(driver.getDevice());
            if (conn == null) { call.reject("Не удалось открыть USB"); return; }
            closeQuietly();
            UsbSerialPort p = driver.getPorts().get(0);
            p.open(conn);
            String par = call.getString("parity", "none");
            p.setParameters(call.getInt("baud", 9600), call.getInt("dataBits", 8),
                    call.getInt("stopBits", 1) == 2 ? UsbSerialPort.STOPBITS_2 : UsbSerialPort.STOPBITS_1,
                    "even".equals(par) ? UsbSerialPort.PARITY_EVEN : "odd".equals(par) ? UsbSerialPort.PARITY_ODD : UsbSerialPort.PARITY_NONE);
            port = p;
            call.resolve();
            notifyListeners("usb", new JSObject());
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    @PluginMethod
    public void writeSerial(PluginCall call) {
        if (port == null) { call.reject("Порт не подключён"); return; }
        try {
            byte[] tmp = new byte[256];
            while (port.read(tmp, 5) > 0) { /* сбросить старые данные перед запросом */ }
            String hex = call.getString("hex", "").replace(" ", "");
            byte[] b = new byte[hex.length() / 2];
            for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            port.write(b, 1000);
            call.resolve();
        } catch (Exception e) { closeQuietly(); call.reject("Ошибка записи: " + e.getMessage()); }
    }

    @PluginMethod
    public void readSerial(PluginCall call) {
        if (port == null) { call.reject("Порт не подключён"); return; }
        try {
            byte[] buf = new byte[256];
            int n = port.read(buf, call.getInt("timeout", 1500));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n; i++) sb.append(String.format("%02X ", buf[i]));
            call.resolve(new JSObject().put("hex", sb.toString().trim()));
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    @PluginMethod
    public void closeSerial(PluginCall call) { closeQuietly(); call.resolve(); }
}
