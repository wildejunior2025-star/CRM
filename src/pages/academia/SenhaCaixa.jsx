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
    let pessoa = null
    try {
      if (temSenha === false) {
        // Primeira vez: está criando a senha agora.
        if (senha.length < 4) throw new Error('A senha precisa de pelo menos 4 números.')
        if (senha !== repetir) throw new Error('As duas senhas não são iguais.')
        const { data, error } = await supabase.rpc('academia_definir_senha', { p_nova: senha })
        if (error) throw error
        if (!data) throw new Error('Não consegui gravar a senha.')
      } else {
        const { data, error } = await supabase.rpc('academia_abrir_caixa', { p_senha: senha })
        if (error) throw error
        if (!data?.ok) throw new Error('Código errado.')
        pessoa = data.nome ? { id: data.id, nome: data.nome } : null
      }
      liberarCaixa(pessoa)
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
        <h2>{temSenha ? '🔒 Seu código do caixa' : '🔒 Criar a senha do caixa'}</h2>
        <p className="ac-muted">
          {temSenha
            ? 'O código é seu, não da academia — é por ele que o sistema sabe quem recebeu.'
            : 'Ninguém cadastrou senha ainda. Escolha uma agora — ela passa a ser pedida pra receber mensalidade e pra ver os pagamentos.'}
        </p>

        {/* NAO use type="password" aqui. O Chrome ignora o autocomplete="off"
            em campo de senha e abre a lista de senhas salvas do SITE por cima
            do campo — na academia (25/11) a recepcao nao conseguia digitar o
            codigo: aparecia "raca@gmail.com / academia.teste@fwcinter.com" em
            cima, e apertar uma tecla preenchia a senha do login inteira.
            Campo de texto comum nao tem esse comportamento; o codigo continua
            escondido pelo CSS da classe ac-codigo. */}
        <label>{temSenha ? 'Código' : 'Senha'}
          <input type="text" inputMode="numeric" autoFocus className="ac-codigo"
            name="codigo-do-caixa" autoComplete="one-time-code" data-lpignore="true"
            value={senha} onChange={e => setSenha(e.target.value.replace(/\D/g, ''))} />
        </label>

        {temSenha === false && (
          <label>Repita a senha
            <input type="text" inputMode="numeric" className="ac-codigo"
              name="repetir-o-codigo" autoComplete="one-time-code" data-lpignore="true"
              value={repetir} onChange={e => setRepetir(e.target.value.replace(/\D/g, ''))} />
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
