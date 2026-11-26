package ru.nextouch.remote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RemotePlugin.class); // до super.onCreate
        super.onCreate(savedInstanceState);
    }
}
