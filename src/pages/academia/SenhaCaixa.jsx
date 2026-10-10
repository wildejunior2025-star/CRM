import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { liberarCaixa } from '../../lib/caixaAcademia'

// Senha do caixa: trava receber mensalidade e ver os pagamentos do dia.
//
// A academia inteira entra com um login só — dono, recepção, quem estiver no
// balcão. Sem isso, qualquer um que pegue o computador recebe dinheiro e vê
// o faturamento do mês. A senha fica cifrada no banco (bcrypt); o site nunca
// vê o hash, só pergunta "essa senha confere?".
//
// Depois de acertar, fica liberado por alguns minutos (ver caixaAcademia.js)
// — quem está recebendo de cinco alunos seguidos não digita cinco vezes.

export default function SenhaCaixa({ onLiberar, onCancelar }) {
  const [temSenha, setTemSenha] = useState(null) // null = ainda conferindo
  const [senha, setSenha] = useState('')
  const [repetir, setRepetir] = useState('')
  const [erro, setErro] = useState(null)
  const [indo, setIndo] = useState(false)

  useEffect(() => {
    supabase.rpc('academia_tem_senha').then(({ data }) => setTemSenha(!!data))
  }, [])

  async function enviar(e) {
    e.preventDefault()
    setErro(null)
    setIndo(true)
    try {
      if (temSenha === false) {
        // Primeira vez: está criando a senha agora.
        if (senha.length < 4) throw new Error('A senha precisa de pelo menos 4 números.')
        if (senha !== repetir) throw new Error('As duas senhas não são iguais.')
        const { data, error } = await supabase.rpc('academia_definir_senha', { p_nova: senha })
        if (error) throw error
        if (!data) throw new Error('Não consegui gravar a senha.')
      } else {
        const { data, error } = await supabase.rpc('academia_conferir_senha', { p_senha: senha })
        if (error) throw error
        if (!data) throw new Error('Senha errada.')
      }
      liberarCaixa()
      onLiberar()
    } catch (err) {
      setErro(err.message)
      setSenha('')
      setRepetir('')
      setIndo(false)
    }
  }

  if (temSenha === null) return null

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <form className="ac-card ac-form ac-modal-caixa" onSubmit={enviar}>
        <h2>{temSenha ? '🔒 Senha do caixa' : '🔒 Criar a senha do caixa'}</h2>
        <p className="ac-muted">
          {temSenha
            ? 'Pra receber mensalidade e ver os pagamentos.'
            : 'Ninguém cadastrou senha ainda. Escolha uma agora — ela passa a ser pedida pra receber mensalidade e pra ver os pagamentos.'}
        </p>

        <label>Senha
          <input type="password" inputMode="numeric" autoFocus autoComplete="off"
            value={senha} onChange={e => setSenha(e.target.value)} />
        </label>

        {temSenha === false && (
          <label>Repita a senha
            <input type="password" inputMode="numeric" autoComplete="off"
              value={repetir} onChange={e => setRepetir(e.target.value)} />
          </label>
        )}

        {erro && <div className="ac-erro">{erro}</div>}

        <div className="ac-form-botoes">
          <button type="button" className="btn btn-secondary" onClick={onCancelar} disabled={indo}>Cancelar</button>
          <button className="btn btn-primary" disabled={indo}>
            {indo ? 'Conferindo...' : temSenha ? 'Entrar' : 'Criar senha'}
          </button>
        </div>
      </form>
    </div>
  )
}
