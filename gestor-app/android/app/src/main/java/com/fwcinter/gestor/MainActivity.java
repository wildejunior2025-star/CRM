package com.fwcinter.gestor;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Cobrança pela maquininha Stone (Deeplink). Precisa ser registrado antes do super.
        registerPlugin(StonePayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
