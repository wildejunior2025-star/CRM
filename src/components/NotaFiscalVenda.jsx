// Nota fiscal (NFC-e) de UMA venda — seja ela pedido de delivery/balcão ou
// conta de mesa.
//
// Nasceu porque a venda de salão não tinha como emitir: o botão só existia no
// delivery, e a mesa é a maior parte do movimento do Agv. Em vez de copiar a
// lógica fiscal pra segunda tela (duas cópias que amanhã discordam uma da
// outra), ela mora aqui e as duas telas chamam.
//
// Quem chama diz só o que a venda é:
//   { tipo: 'pedido',  id, itens, forma_pagamento, status }
//   { tipo: 'comanda', id, itens, forma_pagamento, status }
// Os itens vêm no formato de quem tem: o normalizador abaixo acerta.
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { fwcFetch } from '../lib/appFwc'

// Cada tela guarda o item com o nome de coluna dela. Aqui vira um formato só —
// e a quantidade NÃO é arredondada, porque self-service lança 0,398 kg.
function normalizarItens(lista) {
  return (Array.isArray(lista) ? lista : [])
    .filter(i => i?.status !== 'cancelado')
    .map(i => ({
      nome: i.nome ?? i.descricao ?? 'Item',
      quantidade: Number(i.quantidade ?? i.qtd ?? 1) || 1,
      preco: Number(i.preco_unitario ?? i.preco ?? 0) || 0,
    }))
}

export default function NotaFiscalVenda({ empresaId, venda, compacto = false }) {
  const [pronta, setPronta] = useState(false)   // a loja emite nota?
  const [nota, setNota] = useState(null)
  const [cpf, setCpf] = useState('')
  const [emitindo, setEmitindo] = useState(false)
  const [msg, setMsg] = useState(null)

  const ehComanda = venda?.tipo === 'comanda'
  const vendaId = venda?.id

  const carregar = useCallback(async () => {
    if (!empresaId || !vendaId) return
    const coluna = ehComanda ? 'comanda_id' : 'pedido_id'
    const [fis, nf] = await Promise.all([
      supabase.from('empresa_fiscal').select('ativo, focus_registrada').eq('empresa_id', empresaId).maybeSingle(),
      supabase.from('nfce_notas').select('*')
        .eq(coluna, vendaId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    setPronta(!!(fis.data?.ativo && fis.data?.focus_registrada))
    setNota(nf.data ?? null)
  }, [empresaId, vendaId, ehComanda])
  useEffect(() => { setMsg(null); setCpf(''); carregar() }, [carregar])

  // Loja que não emite nota não vê nada disso — a tela não ganha botão morto.
  if (!pronta || !venda || venda.status === 'cancelado') return null

  async function emitir() {
    const cpfLimpo = cpf.replace(/\D/g, '')
    if (cpf.trim() && cpfLimpo.length !== 11) {
      setMsg({ ok: false, txt: 'CPF precisa ter 11 números (ou deixe em branco).' }); return
    }
    setEmitindo(true); setMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const base = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'
      const r = await fetch(`${base}/functions/v1/emitir-nfce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          acao: 'emitir',
          ...(ehComanda ? { comanda_id: vendaId } : { pedido_id: vendaId }),
          cpf: cpfLimpo || undefined,
        }),
      })
      const resp = await r.json()
      if (resp?.ok || resp?.ja_emitida) {
        setMsg({ ok: true, txt: resp?.ja_emitida ? 'Esta venda já tem nota.' : 'Nota autorizada!' })
        if (resp?.nota && !resp?.ja_emitida) await imprimir(resp.nota, false)
      } else if (resp?.status === 'processando') {
        setMsg({ ok: true, txt: 'Enviada. Aguardando a SEFAZ autorizar — veja em instantes.' })
      } else {
        setMsg({ ok: false, txt: resp?.mensagem || resp?.error || 'Não foi possível emitir.' })
      }
    } catch (e) {
      setMsg({ ok: false, txt: String(e?.message ?? e) })
    } finally {
      setEmitindo(false)
      carregar()
    }
  }

  // Cupom fiscal na térmica deste computador (app Impressora FWC).
  async function imprimir(n, segundaVia) {
    setMsg(null)
    try {
      const { data: emp } = await supabase.from('empresas')
        .select('nome, razao_social, cnpj, endereco, numero, bairro, cidade, estado').eq('id', empresaId).maybeSingle()
      const r = await fwcFetch('/api/imprimir-nfce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nota: {
            ...n,
            forma_pagamento: venda.forma_pagamento ?? null,
            emitida_em: new Date(n.created_at).toLocaleString('pt-BR'),
          },
          empresa: emp,
          itens: normalizarItens(venda.itens),
          segunda_via: !!segundaVia,
        }),
      })
      const j = await r.json()
      setMsg(j?.ok
        ? { ok: true, txt: 'Cupom enviado para a impressora.' }
        : { ok: false, txt: j?.erro === 'sem impressora'
            ? 'Nenhuma impressora configurada neste computador.'
            : 'O app Impressora FWC deste computador está desatualizado. Feche ele pelo ícone perto do relógio e abra de novo.' })
    } catch {
      setMsg({ ok: false, txt: 'O navegador não chegou no app Impressora FWC deste computador. Confira se ele está aberto.' })
    }
  }

  const autorizada = nota?.status === 'autorizada'
  const teste = nota && nota.ambiente !== 'producao'
  const btn = {
    width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
    fontSize: 13.5, fontWeight: 700,
  }

  return (
    <div style={{ marginTop: compacto ? 8 : 12 }}>
      {autorizada ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', textAlign: 'center' }}>
            ✅ Nota {nota.numero ? `nº ${nota.numero}` : ''} emitida{teste ? ' (teste)' : ''}
          </div>
          <button type="button" onClick={() => imprimir(nota, true)} style={btn}>
            🖨️ Imprimir cupom fiscal de novo
          </button>
        </>
      ) : (
        <>
          {nota?.status === 'rejeitada' && (
            <div style={{ fontSize: 12.5, color: '#dc2626', marginBottom: 6 }}>
              Última tentativa foi rejeitada: {nota.motivo_rejeicao || 'sem motivo'}
            </div>
          )}
          <input
            value={cpf} onChange={e => setCpf(e.target.value)} inputMode="numeric"
            placeholder="CPF na nota (opcional)"
            style={{ width: '100%', padding: '9px 11px', borderRadius: 8, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text)', fontSize: 13.5 }}
          />
          <button type="button" onClick={emitir} disabled={emitindo}
            style={{ ...btn, cursor: emitindo ? 'wait' : 'pointer',
              border: '1.5px solid var(--primary)', background: 'rgba(124,58,237,.08)',
              color: 'var(--primary)', fontWeight: 800 }}>
            {emitindo ? 'Emitindo…' : '🧾 Emitir nota fiscal'}
          </button>
        </>
      )}
      {msg && (
        <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, textAlign: 'center',
          color: msg.ok ? '#16a34a' : '#dc2626' }}>{msg.txt}</div>
      )}
    </div>
  )
}
