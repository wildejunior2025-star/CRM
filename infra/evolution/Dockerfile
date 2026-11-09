# Evolution API 2.3.7 com a correção do "conectado mas surdo".
#
# O QUE ESTA PASTA É
# Não faz parte do app do CRM. É a imagem do servidor de WhatsApp (Evolution)
# que roda no Railway, projeto eloquent-hope, serviço "Evolution API".
# O Railway aponta pra cá com Root Directory = infra/evolution.
#
# POR QUE EXISTE (09/11/2026)
# Quatro lojas ficaram conectadas e sem receber NENHUMA mensagem: CDBom em
# 02/11, Estação 04/11, Zebu 05/11, CL Pescados e DayCakes 06/11. A DayCakes
# tinha 1 dia de vida — não era desgaste, nem volume, nem o nosso código.
#
# Desde o fim de setembro/2026 o WhatsApp manda stanza <status> no nível de
# cima da conversa. O Baileys 7.0.0-rc.9, que a 2.3.7 embute, não confirma o
# recebimento. O servidor do WhatsApp espera ~50 min e FECHA o stream. A
# sessão reconecta em 1-3 s, o mesmo stanza é reenviado, não é confirmado de
# novo — e a partir daí a sessão fica "open" e não entrega mais nada.
# Enviar continua funcionando, por isso a tela mostra "Conectado".
#   evolution-api#2778 · baileys#2858 · correção: baileys#2883
#
# Não existe versão estável com a correção: a 2.3.7 É a mais nova.
#
# A ETIQUETA É FIXA DE PROPÓSITO
# O serviço rodava `:latest`. Fixar em v2.3.7 é o que estava no ar e é a
# versão em que a correção foi conferida. Com `latest`, uma atualização
# silenciosa poderia trocar o Baileys e a correção virar inútil sem ninguém
# notar — e aí o script aborta o build, que é o certo, mas no meio da noite.
#
# PRA VOLTAR ATRÁS
# Railway → serviço Evolution API → Settings → Source → Disconnect, e conectar
# de volta a imagem `evoapicloud/evolution-api:latest`. Ou Deployments → o
# deploy anterior → Redeploy. As variáveis e os volumes não são tocados.

FROM evoapicloud/evolution-api:v2.3.7

COPY corrige-status.js /tmp/corrige-status.js

# Falha o build se a correção não aplicar. Imagem que sobe sem ela é pior que
# build quebrado: o problema volta calado e a gente perde dias de novo.
RUN node /tmp/corrige-status.js && rm /tmp/corrige-status.js
