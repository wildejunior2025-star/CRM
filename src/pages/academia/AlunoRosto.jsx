import { useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import CapturaRosto from './CapturaRosto'

// O aluno cadastra o próprio rosto pelo celular. É o mesmo passo a passo da
// recepção; muda só o que acontece no fim e o aceite da LGPD, que aqui é ele
// mesmo quem dá.

export default function AlunoRosto({ aluno, onPronto }) {
  const [consentiu, setConsentiu] = useState(!!aluno.consentimento_em)
  const [capturando, setCapturando] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  async function salvar(rosto) {
    setCapturando(false)
    setSalvando(true)
    setErro(null)
    const { error } = await supabase
      .from('academia_alunos')
      .update({
        descritores: rosto.descritores,
        foto: rosto.foto,
        consentimento_em: aluno.consentimento_em || new Date().toISOString(),
      })
      .eq('id', aluno.id)
    setSalvando(false)
    if (error) return setErro('Não deu pra salvar: ' + error.message)
    onPronto()
  }

  if (capturando) {
    return <CapturaRosto alunos={[]} onPronto={salvar} onCancelar={() => setCapturando(false)} />
  }

  return (
    <div className="al-tela">
      <header className="al-topo">
        <div>
          <span className="al-ola">Entrar pelo rosto</span>
          <h1>{aluno.descritores?.length ? 'Atualizar foto' : 'Cadastrar foto'}</h1>
        </div>
        {aluno.foto && <img className="al-foto" src={aluno.foto} alt="" />}
      </header>

      <section className="al-bloco">
        <p className="al-texto">
          Com seu rosto cadastrado, a catraca abre sozinha quando você chega. São 4 passos rápidos:
          olhar de frente, virar pra um lado, pro outro e olhar de frente de novo.
        </p>
        <ul className="al-dicas">
          <li>Fique num lugar claro, de preferência com a luz na sua frente.</li>
          <li>Tire boné e óculos escuros.</li>
          <li>Só você na tela.</li>
        </ul>
      </section>

      <label className="al-consentimento">
        <input type="checkbox" checked={consentiu} onChange={e => setConsentiu(e.target.checked)} />
        <span>
          Autorizo a academia a usar meu rosto <b>só para liberar minha entrada</b>. Posso pedir pra apagar
          quando quiser.
        </span>
      </label>

      {erro && <div className="al-erro">{erro}</div>}

      <footer className="al-rodape">
        <button className="al-botao" disabled={!consentiu || salvando} onClick={() => setCapturando(true)}>
          {salvando ? 'Salvando...' : 'Começar'}
        </button>
        <button className="al-botao texto" onClick={onPronto}>Agora não</button>
      </footer>
    </div>
  )
}
