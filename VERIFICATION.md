# Verificação da edição de portfólio v1.13.1

Ambiente de execução: Node.js 24.22.1. A versão original passou em 52 testes antes das alterações.

## Resultado

`npm run check`: **60 testes aprovados**, sem falhas ou testes ignorados. O comando verifica a sintaxe de todos os módulos JavaScript e executa a suíte em série.

## Novas regressões verificadas

- Provedores e consulta de cotações bloqueados com configuração padrão, mesmo com chave no ambiente.
- Importação exige cotações fictícias; exemplos preservam cálculo e histórico.
- 1X2 sem empate não gera surebet e não pode ser registrado.
- Dados reais vencidos não geram cálculo; partida passada é rejeitada.
- Casa, mercado e oferta suspensos não são importados pelo adaptador.
- Ausência de horário do provedor não é substituída pelo momento da consulta.
- Adaptadores recebem sinal de cancelamento com prazo definido.
- Exemplo CSV importa 40 partidas sem duplicação, preservando ausentes e recortes por local.
- Requisições de outra origem não alteram dados pela API.

## Escopo e limites

Os testes anteriores continuam cobrindo cálculos, SQLite, migração, importação CSV/JSON, pareamento de equipes, provedores simulados e análise histórica. A primeira inicialização foi verificada com banco descartável separado.

Não houve consulta a provedores reais, uso de credenciais reais ou publicação no GitHub. A inicialização de Chromium para inspeção visual foi bloqueada pelo ambiente; não se afirma validação visual, ausência de overflow ou testes ponta a ponta em navegador. A validação automatizada da interface nesta entrega cobre sintaxe e resposta HTTP, não sua renderização.

A auditoria de segredos é limitada aos arquivos entregues. Histórico de um repositório remoto, dados do computador do autor e vulnerabilidades atuais das dependências exigem verificações próprias. Não se apresenta a entrega como auditoria completa de segurança ou parecer jurídico.

## Dependências — 11/11/2026

O npm identificou duas vulnerabilidades transitivas: GHSA-27r3-jxmh-p828 (`body-parser`, alta) e GHSA-6pq8-jhm2-2vcw (`qs`, moderada). A atualização compatível instalou `body-parser@2.4.0` e `qs@6.17.1`, sem alteração da dependência direta Express 5.1.0. `npm audit` retornou zero vulnerabilidades conhecidas nessa consulta. Isso não garante ausência de falhas ainda desconhecidas.

Validação manual relatada pelo usuário: troca de recortes 5/10, tratamento de dados ausentes, data de corte, divisão da stake virtual, registro de cálculo, liquidação/correção de saldo e persistência do histórico após reiniciar. Esses testes foram feitos na v1.13.0 antes da atualização das duas dependências.
