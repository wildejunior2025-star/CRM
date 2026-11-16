package com.fwcinter.gestor;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Cobrança pela maquininha Stone (POS Android) via Deeplink.
 *
 * O app chama o app de pagamento da Stone (esquema payment-app://pay) com o valor
 * em centavos e o tipo (débito, crédito, Pix). A Stone abre a tela dela, o cliente
 * passa o cartão e ela devolve o resultado para esta activity pelo esquema
 * fwcstone://pay-response (configurado no AndroidManifest).
 *
 * Documentação: sdkandroid.stone.com.br (Deeplink). Só funciona dentro de um POS Android
 * da Stone, com os aplicativos Stone instalados.
 *
 * O resultado também é gravado em SharedPreferences: se o Android matar o app enquanto
 * a tela da Stone está aberta, o resultado de um pagamento que JÁ passou no cartão não
 * pode se perder. A página consulta isso em ultimoResultado().
 */
@CapacitorPlugin(name = "StonePay")
public class StonePayPlugin extends Plugin {

    private static final String RETURN_SCHEME = "fwcstone";
    private static final String PREFS = "fwc_stone_pay";
    private static final String CHAVE_ULTIMO = "ultimo";

    private PluginCall chamadaPendente = null;

    private Intent intentDePagamento() {
        Uri uri = new Uri.Builder().scheme("payment-app").authority("pay").build();
        return new Intent(Intent.ACTION_VIEW, uri);
    }

    /** O app de pagamento da Stone está neste aparelho? (só POS Stone responde sim) */
    @PluginMethod
    public void disponivel(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        ResolveInfo ri = pm.resolveActivity(intentDePagamento(), 0);
        JSObject ret = new JSObject();
        ret.put("disponivel", ri != null);
        call.resolve(ret);
    }

    /**
     * Cobra um valor. Parâmetros:
     *  - centavos (int, obrigatório): valor em centavos
     *  - tipo: "DEBIT" | "CREDIT" | "PIX" | "VOUCHER" (opcional; sem ele a Stone pergunta na tela)
     *  - parcelas: 1 = à vista; 2 a 99 = parcelado (opcional)
     *  - tipoParcela: "MERCHANT" (sem juros) | "ISSUER" (com juros), só se parcelas > 1
     *  - pedido: id do pedido para a filipeta (opcional; o POS precisa ter essa função ligada)
     * A promessa só resolve quando a Stone devolve o resultado.
     */
    @PluginMethod
    public void pagar(PluginCall call) {
        Integer centavos = call.getInt("centavos");
        if (centavos == null || centavos <= 0) {
            call.reject("Valor inválido.");
            return;
        }
        if (chamadaPendente != null) {
            call.reject("Já existe uma cobrança aberta na maquininha. Termine ou cancele ela antes.");
            return;
        }

        Uri.Builder b = new Uri.Builder().scheme("payment-app").authority("pay");
        b.appendQueryParameter("return_scheme", RETURN_SCHEME);
        b.appendQueryParameter("amount", String.valueOf(centavos));
        b.appendQueryParameter("editable_amount", "0");

        String tipo = call.getString("tipo");
        if (tipo != null && !tipo.isEmpty()) {
            b.appendQueryParameter("transaction_type", tipo.toUpperCase());
        }
        Integer parcelas = call.getInt("parcelas");
        if (parcelas != null && parcelas > 1) {
            String tp = call.getString("tipoParcela", "MERCHANT");
            b.appendQueryParameter("installment_type", tp);
            b.appendQueryParameter("installment_count", String.valueOf(parcelas));
        } else if ("CREDIT".equalsIgnoreCase(tipo)) {
            b.appendQueryParameter("installment_type", "NONE");
        }
        String pedido = call.getString("pedido");
        if (pedido != null && !pedido.isEmpty()) {
            b.appendQueryParameter("order_id", pedido);
        }

        limparUltimo();
        chamadaPendente = call;
        call.setKeepAlive(true);
        try {
            Intent it = new Intent(Intent.ACTION_VIEW, b.build());
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(it);
        } catch (Exception e) {
            chamadaPendente = null;
            call.reject("Não consegui abrir o app de pagamento da Stone neste aparelho.");
        }
    }

    /** Cancela (estorna) uma venda já aprovada pelo ATK que a Stone devolveu no pagamento. */
    @PluginMethod
    public void cancelar(PluginCall call) {
        String atk = call.getString("atk");
        Integer centavos = call.getInt("centavos");
        if (atk == null || atk.isEmpty()) {
            call.reject("Falta o código da transação (ATK).");
            return;
        }
        if (chamadaPendente != null) {
            call.reject("Já existe uma operação aberta na maquininha.");
            return;
        }
        Uri.Builder b = new Uri.Builder().scheme("cancel-app").authority("cancel");
        b.appendQueryParameter("returnscheme", RETURN_SCHEME);
        b.appendQueryParameter("atk", atk);
        if (centavos != null && centavos > 0) {
            b.appendQueryParameter("amount", String.valueOf(centavos));
        }
        b.appendQueryParameter("editable_amount", "false");

        chamadaPendente = call;
        call.setKeepAlive(true);
        try {
            Intent it = new Intent(Intent.ACTION_VIEW, b.build());
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(it);
        } catch (Exception e) {
            chamadaPendente = null;
            call.reject("Não consegui abrir o app de cancelamento da Stone.");
        }
    }

    /** Último retorno da Stone que chegou (sobrevive se o app foi fechado no meio da cobrança). */
    @PluginMethod
    public void ultimoResultado(PluginCall call) {
        String json = prefs().getString(CHAVE_ULTIMO, null);
        JSObject ret = new JSObject();
        if (json == null) {
            ret.put("existe", false);
        } else {
            try {
                ret = new JSObject(json);
                ret.put("existe", true);
            } catch (Exception e) {
                ret = new JSObject();
                ret.put("existe", false);
            }
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void limparUltimoResultado(PluginCall call) {
        limparUltimo();
        call.resolve();
    }

    /** Chega aqui quando a Stone devolve o resultado (fwcstone://pay-response ou ://cancel). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null || !RETURN_SCHEME.equals(data.getScheme())) return;

        JSObject r = new JSObject();
        r.put("operacao", "cancel".equals(data.getHost()) ? "cancelamento" : "pagamento");
        String[] chaves = {
            "code", "success", "reason", "message", "response_code",
            "amount", "atk", "itk", "brand", "authorization_code", "authorization_date_time",
            "installment_count", "pan", "type", "entry_mode", "order_id", "cardholder_name",
            "canceledamount", "transactionamount", "paymenttype", "orderid", "responsecode",
            "transaction_qualifier"
        };
        for (String k : chaves) {
            String v = data.getQueryParameter(k);
            if (v != null) r.put(k, v);
        }

        String code = data.getQueryParameter("code");
        String success = data.getQueryParameter("success");
        boolean ok;
        if ("cancel".equals(data.getHost())) {
            ok = "true".equalsIgnoreCase(success);
        } else {
            ok = "0".equals(code) && !"false".equalsIgnoreCase(success);
        }
        r.put("ok", ok);

        prefs().edit().putString(CHAVE_ULTIMO, r.toString()).apply();

        PluginCall c = chamadaPendente;
        chamadaPendente = null;
        if (c != null) {
            c.resolve(r);
        }
        // Avisa a página mesmo sem chamada pendente (app recriado no meio da cobrança).
        notifyListeners("stoneResultado", r, true);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void limparUltimo() {
        prefs().edit().remove(CHAVE_ULTIMO).apply();
    }
}
