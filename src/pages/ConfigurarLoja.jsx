// Configurar Loja — o passo a passo da loja nova (mig 0273), no modelo da Brendi.
//
// Centro: a assistente conversando, uma etapa por vez, sempre puxando a próxima.
// Direita: a lista com o progresso. Clicar numa etapa da lista leva direto pra
// tela dela, sem conversa (o dono pediu assim).
//
// Fase 1: a assistente só explica e leva até a tela certa. Quem grava é a tela
// que já existe. As duas etapas que não têm tela própria (dados do CNPJ e
// pedido teste) acontecem aqui mesmo, dentro da conversa.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useConfigurarLoja, avisarConfigurarLoja } from '../hooks/useConfigurarLoja'
import { linkDaLoja } from '../lib/configurarLoja'
import { formatCnpj, cnpjValido } from '../lib/cnpj'
import { fwcFetch } from '../lib/appFwc'
import './ConfigurarLoja.css'

const WHATS_FWC = 'https://wa.me/5584998214212'
export const MARCA_VOLTAR = 'cfg_loja_voltar'

export default function ConfigurarLoja() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { status, carregando, etapas, atual, pendentesObrigatorias, concluido, marcar } = useConfigurarLoja()
  // Etapas abertas na conversa, em ordem. A última é a que tem os botões.
  const [vistos, setVistos] = useState([])
  const [concluindo, setConcluindo] = useState(false)
  const fimRef = useRef(null)

  const obrigatorias = etapas.filter(e => !e.opcional)
  const opcionais = etapas.filter(e => e.opcional)
  const feitasObrig = obrigatorias.filter(e => e.feita).length
  const podeVender = obrigatorias.length > 0 && pendentesObrigatorias.length === 0

  // Chegou aqui: apaga o "voltar pro passo a passo" das outras telas.
  useEffect(() => { try { sessionStorage.removeItem(MARCA_VOLTAR) } catch { /* sem storage */ } }, [])

  // A etapa da vez entra na conversa sozinha — inclusive quando o dono volta de
  // outra tela com a anterior resolvida.
  useEffect(() => {
    if (!atual) return
    setVistos(v => (v[v.length - 1] === atual.id ? v : [...v.filter(id => id !== atual.id), atual.id]))
  }, [atual?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fimRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [vistos.length, podeVender])

  const porId = useMemo(() => Object.fromEntries(etapas.map(e => [e.id, e])), [etapas])

  function abrirNaConversa(id) {
    setVistos(v => [...v.filter(x => x !== id), id])
  }

  function irPraTela(etapa) {
    try { sessionStorage.setItem(MARCA_VOLTAR, '1') } catch { /* sem storage */ }
    navigate(etapa.rota)
  }

  // Clique na lista da direita: etapa com tela vai direto; as de dentro da
  // conversa abrem aqui.
  function clicarNaLista(etapa) {
    if (etapa.rota && !etapa.inline) irPraTela(etapa)
    else abrirNaConversa(etapa.id)
  }

  async function concluir() {
    setConcluindo(true)
    await marcar('concluir')
    setConcluindo(false)
    navigate('/')
  }

  function duvida(etapa) {
    window.dispatchEvent(new CustomEvent('assistente-loja:abrir', {
      detail: { pergunta: etapa ? `Tenho uma dúvida sobre ${etapa.titulo.toLowerCase()}: ` : '' },
    }))
  }

  if (carregando) return <div className="cfg-carregando">Carregando…</div>
  if (!status) return <div className="cfg-carregando">Só o administrador da loja configura a loja.</div>

  const primeiroNome = String(profile?.nome ?? '').trim().split(/\s+/)[0]
  const jaProntas = etapas.filter(e => e.feita)
  const pendentes = etapas.filter(e => !e.feita)

  return (
    <div className="cfg">
      <header className="cfg-topo">
        <div>
          <h1>Configurar Loja</h1>
          <p>Siga o passo a passo. As etapas <b className="cfg-txt-obrig">obrigatórias</b> são as que a loja online precisa pra vender; as opcionais dá pra pular e fazer depois.</p>
        </div>
        {concluido && <span className="cfg-selo-ok">✅ Configuração concluída</span>}
      </header>

      <div className="cfg-grade">
        {/* ── Conversa ─────────────────────────────────────────────── */}
        <section className="cfg-chat" aria-label="Assistente de configuração">
          <div className="cfg-chat-topo">
            <span className="cfg-avatar" aria-hidden>🤖</span>
            <div>
              <strong>Assistente FWC</strong>
              <small>configurando sua loja</small>
            </div>
          </div>

          <div className="cfg-mensagens">
            <Balao>
              <p>Oi{primeiroNome ? `, ${primeiroNome}` : ''}! 👋 Vou te ajudar a deixar a <b>{status.nome}</b> pronta pra vender.</p>
              <p>São <b>{obrigatorias.length} etapas obrigatórias</b>, sem elas a loja online não funciona, e <b>{opcionais.length} opcionais</b>, que você pode pular e fazer quando quiser.</p>
            </Balao>

            {jaProntas.length > 0 && (
              <Balao>
                <p>✅ Já está pronto: {jaProntas.map(e => e.titulo).join(', ')}.</p>
              </Balao>
            )}

            {vistos.map((id, i) => {
              const etapa = porId[id]
              if (!etapa) return null
              const ultima = i === vistos.length - 1
              return (
                <div key={`${id}-${i}`} className="cfg-bloco">
                  {i > 0 && <div className="cfg-balao-eu">Quero ver: {etapa.titulo}</div>}
                  <CartaoEtapa
                    etapa={etapa}
                    status={status}
                    completo={ultima}
                    onAbrirTela={() => irPraTela(etapa)}
                    onPular={() => marcar('pular', etapa.id)}
                    onFeito={() => marcar('feito', etapa.id)}
                    onDesfazer={() => marcar('desfazer', etapa.id)}
                    onDuvida={() => duvida(etapa)}
                  />
                </div>
              )
            })}

            {podeVender && !concluido && (
              <Balao destaque>
                <p>🎉 <b>Tudo que é obrigatório está pronto!</b> Sua loja já pode vender.</p>
                {pendentes.length > 0 && (
                  <p>Ainda dá pra caprichar nas opcionais: {pendentes.map(e => e.titulo).join(', ')}. Não precisa agora.</p>
                )}
                <div className="cfg-acoes">
                  <button type="button" className="btn btn-primary" onClick={concluir} disabled={concluindo}>
                    {concluindo ? 'Concluindo…' : 'Concluir configuração'}
                  </button>
                </div>
              </Balao>
            )}
            <div ref={fimRef} />
          </div>

          {pendentes.length > 0 && (
            <div className="cfg-chips">
              {pendentes.map(e => (
                <button key={e.id} type="button" onClick={() => abrirNaConversa(e.id)}
                  className={`cfg-chip${e.opcional ? '' : ' obrig'}`}>
                  {e.curto}
                </button>
              ))}
              <button type="button" className="cfg-chip duvida" onClick={() => duvida(null)}>💬 Tenho uma dúvida</button>
            </div>
          )}
        </section>

        {/* ── Lista com o progresso ─────────────────────────────────── */}
        <aside className="cfg-lado" aria-label="Sua configuração">
          <div className="cfg-progresso">
            <Anel feitas={feitasObrig} total={obrigatorias.length} />
            <div>
              <strong>Sua configuração</strong>
              <small>
                {podeVender ? 'Loja pronta pra vender ✅'
                  : `Faltam ${pendentesObrigatorias.length} obrigatória${pendentesObrigatorias.length > 1 ? 's' : ''} pra loja vender`}
              </small>
            </div>
          </div>

          <ListaEtapas titulo="Obrigatório pra vender" etapas={obrigatorias} atual={atual} onClick={clicarNaLista} />
          <ListaEtapas titulo="Opcional" etapas={opcionais} atual={atual} onClick={clicarNaLista} />

          <a className="cfg-ajuda" href={WHATS_FWC} target="_blank" rel="noreferrer">🙋 Preciso de ajuda</a>
        </aside>
      </div>
    </div>
  )
}

function Balao({ children, destaque }) {
  return (
    <div className="cfg-linha">
      <span className="cfg-avatar mini" aria-hidden>🤖</span>
      <div className={`cfg-balao${destaque ? ' destaque' : ''}`}>{children}</div>
    </div>
  )
}

function Anel({ feitas, total }) {
  const r = 22
  const c = 2 * Math.PI * r
  const pct = total ? feitas / total : 0
  return (
    <svg className="cfg-anel" width="58" height="58" viewBox="0 0 58 58" role="img" aria-label={`${feitas} de ${total} obrigatórias`}>
      <circle cx="29" cy="29" r={r} className="cfg-anel-fundo" />
      <circle cx="29" cy="29" r={r} className={`cfg-anel-cheio${pct === 1 ? ' ok' : ''}`}
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 29 29)" />
      <text x="29" y="33" textAnchor="middle">{feitas}/{total}</text>
    </svg>
  )
}

function ListaEtapas({ titulo, etapas, atual, onClick }) {
  if (!etapas.length) return null
  return (
    <div className="cfg-lista">
      <div className="cfg-lista-titulo">{titulo}</div>
      {etapas.map(e => {
        const estado = e.feita ? 'feita' : e.pulada ? 'pulada' : e.opcional ? 'opcional' : 'falta'
        return (
          <button key={e.id} type="button" className={`cfg-item ${estado}`} onClick={() => onClick(e)}>
            <span className="cfg-item-icone" aria-hidden>
              {e.feita ? '✓' : e.pulada ? '⏭' : e.opcional ? '' : '!'}
            </span>
            <span className="cfg-item-txt">
              <span className="cfg-item-nome">{e.titulo}</span>
              <small>{e.pulada ? 'Pulada, dá pra fazer depois' : e.texto}</small>
            </span>
            {atual?.id === e.id && <span className="cfg-agora">AGORA</span>}
            <span className="cfg-seta" aria-hidden>›</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Uma etapa dentro da conversa ─────────────────────────────────────────────
function CartaoEtapa({ etapa, status, completo, onAbrirTela, onPular, onFeito, onDesfazer, onDuvida }) {
  const [ocupado, setOcupado] = useState(false)
  const rodar = fn => async () => { setOcupado(true); await fn(); setOcupado(false) }

  const classeStatus = etapa.feita ? 'ok' : etapa.opcional ? 'neutro' : 'falta'
  return (
    <div className="cfg-linha">
      <span className="cfg-avatar mini" aria-hidden>🤖</span>
      <div className={`cfg-balao cfg-etapa${completo ? '' : ' compacto'}`}>
        <div className="cfg-etapa-topo">
          <span className={`cfg-tag ${etapa.opcional ? 'opc' : 'obrig'}`}>{etapa.opcional ? 'Opcional' : 'Obrigatório'}</span>
          <strong>{etapa.titulo}</strong>
        </div>
        <div className={`cfg-etapa-status ${classeStatus}`}>
          {etapa.feita ? '✅ ' : etapa.opcional ? '' : '🔴 '}{etapa.pulada ? 'Pulada, dá pra fazer depois' : etapa.texto}
        </div>

        {completo && (
          <>
            {etapa.explica.map((t, i) => <p key={i}>{t}</p>)}

            {etapa.id === 'empresa' && <DadosDoCnpj status={status} />}
            {etapa.id === 'teste' && <PedidoTeste status={status} />}
            {etapa.id === 'horario' && status.horario && status.pausada_manual && <LiberarAbertura />}
            {etapa.id === 'impressora' && !etapa.feita && <VerificarImpressora onAchou={onFeito} />}

            <div className="cfg-acoes">
              {etapa.rota && (
                <button type="button" className={`btn ${etapa.feita ? 'btn-secondary' : 'btn-primary'}`} onClick={onAbrirTela}>
                  {etapa.feita ? 'Revisar' : etapa.botao}
                </button>
              )}
              {etapa.manual && !etapa.feita && (
                <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={rodar(onFeito)}>Já configurei</button>
              )}
              {etapa.manual && etapa.feita && (
                <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={rodar(onDesfazer)}>Desmarcar</button>
              )}
              {etapa.opcional && !etapa.feita && !etapa.pulada && (
                <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={rodar(onPular)}>Pular por agora</button>
              )}
              {etapa.pulada && (
                <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={rodar(onDesfazer)}>Tirar do "pulado"</button>
              )}
              <button type="button" className="cfg-link" onClick={onDuvida}>Tenho uma dúvida</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Dados do CNPJ (Receita, via BrasilAPI) ──────────────────────────────────
const titulo = t => String(t ?? '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, p => p.toLowerCase())

function DadosDoCnpj({ status }) {
  const { empresa } = useAuth()
  const [cnpj, setCnpj] = useState(formatCnpj(status.cnpj ?? ''))
  const [receita, setReceita] = useState(null)
  const [form, setForm] = useState(null)
  const [atualLoja, setAtualLoja] = useState(null)
  const [buscando, setBuscando] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (!empresa?.id) return
    supabase.from('empresas')
      .select('cnpj, razao_social, endereco, numero, bairro, cidade, estado, cep, latitude')
      .eq('id', empresa.id).maybeSingle()
      .then(({ data }) => {
        setAtualLoja(data ?? {})
        if (cnpjValido(data?.cnpj)) buscar(data.cnpj, data)
        else setForm(montarForm(null, data ?? {}))
      })
  }, [empresa?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // O que a loja já preencheu vale mais que a Receita (costuma estar velha);
  // a Receita só completa o que está em branco.
  function montarForm(r, loja) {
    const rua = r ? titulo([r.descricao_tipo_de_logradouro, r.logradouro].filter(Boolean).join(' ')) : ''
    return {
      razao_social: loja.razao_social || r?.razao_social || '',
      endereco: loja.endereco || rua,
      numero: loja.numero || (r?.numero && r.numero !== 'S/N' ? r.numero : ''),
      bairro: loja.bairro || titulo(r?.bairro),
      cidade: loja.cidade || titulo(r?.municipio),
      estado: loja.estado || r?.uf || '',
      cep: loja.cep || r?.cep || '',
    }
  }

  async function buscar(valor = cnpj, loja = atualLoja ?? {}) {
    const n = String(valor).replace(/\D/g, '')
    setMsg(null)
    if (!cnpjValido(n)) { setMsg({ tipo: 'erro', texto: 'CNPJ inválido. Confere os números.' }); return }
    setBuscando(true)
    try {
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${n}`)
      if (!res.ok) throw new Error(String(res.status))
      const r = await res.json()
      setReceita(r)
      setForm(montarForm(r, loja))
    } catch {
      setReceita(null)
      setForm(f => f ?? montarForm(null, loja))
      setMsg({ tipo: 'erro', texto: 'Não consegui consultar a Receita agora. Pode preencher na mão.' })
    }
    setBuscando(false)
  }

  async function salvar() {
    if (!form?.razao_social?.trim()) { setMsg({ tipo: 'erro', texto: 'Preencha a razão social.' }); return }
    setSalvando(true); setMsg(null)
    const loja = atualLoja ?? {}
    const mudouEndereco = ['endereco', 'numero', 'cidade'].some(k => String(form[k] ?? '').trim() !== String(loja[k] ?? '').trim())
    const payload = {
      cnpj: String(cnpj).replace(/\D/g, '') || null,
      razao_social: form.razao_social.trim(),
      endereco: form.endereco.trim() || null,
      numero: form.numero.trim() || null,
      bairro: form.bairro.trim() || null,
      cidade: form.cidade.trim() || null,
      estado: form.estado.trim().toUpperCase().slice(0, 2) || null,
      cep: form.cep.replace(/\D/g, '') || null,
    }
    // Endereço novo = ponto do mapa velho. Sem apagar, a taxa por km seria
    // medida do lugar errado.
    if (mudouEndereco && loja.latitude != null) Object.assign(payload, { latitude: null, longitude: null })
    const { error } = await supabase.from('empresas').update(payload).eq('id', empresa.id)
    setSalvando(false)
    if (error) { setMsg({ tipo: 'erro', texto: 'Não salvou. Tente de novo.' }); return }
    setAtualLoja({ ...loja, ...payload })
    setMsg({ tipo: 'ok', texto: mudouEndereco && loja.latitude != null
      ? 'Salvo! Como o endereço mudou, marque de novo o ponto da loja no mapa (etapa Endereço e entrega).'
      : 'Salvo! ✅' })
    avisarConfigurarLoja()
  }

  const campo = (k, rotulo, props = {}) => (
    <label className={props.largo ? 'largo' : ''}>
      {rotulo}
      <input value={form?.[k] ?? ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} {...props.input} />
    </label>
  )

  return (
    <div className="cfg-widget">
      <div className="cfg-cnpj-busca">
        <label>
          CNPJ
          <input value={cnpj} inputMode="numeric" onChange={e => setCnpj(formatCnpj(e.target.value))} placeholder="00.000.000/0000-00" />
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => buscar()} disabled={buscando}>
          {buscando ? 'Consultando…' : 'Buscar na Receita'}
        </button>
      </div>

      {receita && (
        <div className="cfg-receita">
          <b>{receita.nome_fantasia || receita.razao_social}</b>
          <span>Situação na Receita: <b className={receita.descricao_situacao_cadastral === 'ATIVA' ? 'cfg-txt-ok' : 'cfg-txt-obrig'}>{receita.descricao_situacao_cadastral}</b></span>
          {receita.cnae_fiscal_descricao && <span>{receita.cnae_fiscal_descricao}</span>}
        </div>
      )}

      {form && (
        <>
          <div className="cfg-campos">
            {campo('razao_social', 'Razão social', { largo: true })}
            {campo('endereco', 'Rua', { largo: true })}
            {campo('numero', 'Número')}
            {campo('bairro', 'Bairro')}
            {campo('cidade', 'Cidade')}
            {campo('estado', 'UF', { input: { maxLength: 2 } })}
            {campo('cep', 'CEP', { input: { inputMode: 'numeric' } })}
          </div>
          <div className="cfg-acoes">
            <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando}>
              {salvando ? 'Salvando…' : 'Confirmar dados'}
            </button>
          </div>
        </>
      )}
      {msg && <div className={`cfg-msg ${msg.tipo}`}>{msg.texto}</div>}
    </div>
  )
}

// ── Loja nasce pausada: libera abrir e fechar pelo horário ──────────────────
function LiberarAbertura() {
  const { empresa } = useAuth()
  const [salvando, setSalvando] = useState(false)
  async function liberar() {
    setSalvando(true)
    // Mesmo estado de "fechada pelo relógio": dentro do horário a loja online
    // já aparece aberta, e o gestor segue abrindo e fechando sozinho.
    await supabase.from('empresas').update({ delivery_ativo: false, delivery_fechado_por: 'horario' }).eq('id', empresa.id)
    setSalvando(false)
    avisarConfigurarLoja()
  }
  return (
    <div className="cfg-widget alerta">
      <p><b>Sua loja está pausada.</b> Toda loja nova começa assim, pra ninguém pedir antes de estar tudo pronto. Mesmo com o horário certo, o link mostra "Fechado".</p>
      <button type="button" className="btn btn-primary" onClick={liberar} disabled={salvando}>
        {salvando ? 'Liberando…' : 'Liberar pra abrir no horário'}
      </button>
    </div>
  )
}

// ── Impressora: confere se o app está rodando neste computador ──────────────
function VerificarImpressora({ onAchou }) {
  const [estado, setEstado] = useState(null)
  async function verificar() {
    setEstado('buscando')
    try {
      const r = await fwcFetch('/api/status', { timeout: 2500 })
      if (!r.ok) throw new Error()
      setEstado('achou')
      await onAchou()
    } catch {
      setEstado('nao')
    }
  }
  return (
    <div className="cfg-widget">
      <button type="button" className="btn btn-secondary" onClick={verificar} disabled={estado === 'buscando'}>
        {estado === 'buscando' ? 'Procurando…' : '🖨️ Verificar neste computador'}
      </button>
      {estado === 'achou' && <div className="cfg-msg ok">App da Impressora FWC encontrado ✅</div>}
      {estado === 'nao' && <div className="cfg-msg erro">Não achei o app neste computador. Baixe pelo gestor de pedidos, no menu Impressora.</div>}
    </div>
  )
}

// ── Pedido teste + divulgar o link ──────────────────────────────────────────
function PedidoTeste({ status }) {
  const [copiado, setCopiado] = useState(false)
  const link = linkDaLoja(status)
  async function copiar() {
    try { await navigator.clipboard.writeText(link); setCopiado(true); setTimeout(() => setCopiado(false), 2000) } catch { /* sem clipboard */ }
  }
  const texto = encodeURIComponent(`Agora dá pra pedir na ${status.nome} pelo nosso cardápio online: ${link}`)
  return (
    <div className="cfg-widget">
      {!status.aceita_delivery && (
        <div className="cfg-msg erro">O link ainda não abre: falta ligar o pedido online na etapa Endereço e entrega.</div>
      )}
      <div className="cfg-link-loja">
        <code>{link.replace('https://', '')}</code>
        <button type="button" className="btn btn-secondary" onClick={copiar}>{copiado ? 'Copiado ✓' : 'Copiar'}</button>
      </div>
      <div className="cfg-acoes">
        <a className="btn btn-primary" href={link} target="_blank" rel="noreferrer">Abrir minha loja</a>
        <a className="btn btn-secondary" href={`https://wa.me/?text=${texto}`} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
      </div>
    </div>
  )
}
