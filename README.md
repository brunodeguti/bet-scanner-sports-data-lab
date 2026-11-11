# Bet Scanner — Sports Data Lab

Aplicação local para explorar estatísticas de futebol e simular cálculos de probabilidade, valor esperado e arbitragem com cotações fictícias. Desenvolvida com **Node.js, Express e SQLite**, com interface em JavaScript, HTML e CSS.

O projeto nasceu de um scanner de odds. Esta versão de portfólio preserva os módulos de cálculo, importação, persistência e testes, mas inicia **offline**, sem acesso a casas de apostas e sem exigir credenciais. Os adaptadores externos permanecem no código para estudo e testes com respostas simuladas.

## O que você pode explorar

- Importar partidas por CSV, validando dados antes de gravar no SQLite.
- Comparar últimos 5 e 10 jogos por equipe, em casa, fora e no geral.
- Consultar gols, cartões, escanteios, finalizações e chutes no gol, com quantidade de observações por métrica.
- Preservar dados ausentes como indisponíveis, sem transformá-los em zero.
- Aplicar uma data de corte para excluir partidas posteriores do histórico.
- Simular arbitragem, remoção proporcional de margem, EV e Kelly fracionado.
- Registrar cenários e corrigir sua liquidação sem aplicar o mesmo resultado duas vezes ao saldo virtual.
- Analisar frequências históricas de seleções, incluindo push e meias liquidações.

**Todos os valores financeiros são virtuais.** Não há depósitos, saques, links de afiliados ou execução de apostas. Marcar um arquivo como fictício é uma declaração do usuário: o sistema não consegue verificar a procedência de dados inseridos manualmente.

## Executar localmente

Requisito: **Node.js 24 ou superior**. A aplicação usa o SQLite integrado ao Node e não exige um serviço de banco separado.

```bash
npm ci
npm start
```

Abra <http://localhost:3000>. No Windows, também é possível usar `INICIAR-WINDOWS.cmd`.

A primeira inicialização cria um banco local com três mercados fictícios e **40 partidas sintéticas**. Não é preciso configurar `.env` nem contratar uma API. O navegador consulta apenas o servidor local; `npm ci` precisa de acesso ao registro de pacotes.

### Roteiro de demonstração

1. Abra o laboratório de simulações. Altere a alocação virtual de um cenário e confira o arredondamento em centavos.
2. Registre um cálculo e use o histórico para simular resultado e correção do saldo virtual.
3. Abra **FootyStats CSV**, selecione a temporada `demo-sports • 2026/2027` e compare `Azul FC` com `Laranja FC`.
4. Troque o recorte entre 5/10 jogos e casa/fora/geral. Algumas finalizações do exemplo estão ausentes de propósito.
5. No painel de análise histórica, crie um cenário com data em `2026-11-01` e adicione seleções. As frequências descrevem a amostra; não são previsões validadas.

As datas dos exemplos são fixas para tornar a demonstração reproduzível. Cotações fictícias podem ser analisadas como cenários históricos; dados reais antigos não recebem o mesmo tratamento.

## Decisões técnicas

| Decisão | Motivo |
| --- | --- |
| `createApp` separado do servidor | Testar rotas HTTP com banco em memória e provedores simulados. |
| SQLite com chaves estrangeiras, WAL e transações | Preservar relações e evitar importações parcialmente gravadas. |
| Consultas SQL com parâmetros | Separar os dados recebidos das instruções SQL. |
| Atualização idempotente na importação | Reimportar um conjunto sem duplicar suas partidas. |
| Migração aditiva | Acrescentar campos sem apagar registros anteriores. |
| Divisão de valores em centavos | Distribuir o total virtual sem perder centavos por arredondamento. |
| Contagem de observações por métrica | Distinguir amostra completa de estatísticas parcialmente disponíveis. |
| Bloqueio de provedores no servidor | Desativar consultas externas mesmo que existam chaves no ambiente. |

Veja [arquitetura e fluxos](docs/ARCHITECTURE.md), [alterações desta versão](CHANGELOG.md) e [verificação técnica](VERIFICATION.md).

## Testes

```bash
npm run check
```

O comando verifica a sintaxe de todos os arquivos JavaScript de `src`, `public`, `scripts` e `test`, e executa os testes em série. A suíte possui **60 testes**. Usa banco em memória, servidores HTTP locais e transportes simulados; nenhuma chave real é necessária.

O workflow de [integração contínua](.github/workflows/ci.yml) executa os mesmos checks com Node.js 24 no GitHub Actions.

## Formatos de entrada

### Cotações fictícias

Use [demo-odds.json](examples/demo-odds.json) ou [demo-odds.csv](examples/demo-odds.csv) como referência. O endpoint da versão de portfólio exige `is_demo=true` em todas as linhas.

| Campo | Conteúdo |
| --- | --- |
| `sport`, `event`, `starts_at` | Esporte, evento e data ISO 8601. |
| `market_key`, `outcome`, `bookmaker`, `odds` | Identificação do cenário, resultado, fonte fictícia e cotação decimal maior que 1. |
| `is_demo` | Obrigatório com valor `true` nesta versão. |
| `expected_outcomes` | Array com os 2 ou 3 resultados exclusivos que cobrem o cenário completo. Em CSV, use um array JSON escapado. |
| `captured_at` | Data da observação. Recomenda-se informá-la mesmo em simulações. |
| `estimated_probability` | Opcional: hipótese manual entre 0 e 1. |
| `is_reference` | Opcional: identifica uma fonte para remoção proporcional da margem. |

Mercados 1X2 conhecidos exigem três resultados; totais conhecidos podem reconhecer o par over/under. Cenários personalizados exigem definição explícita dos resultados. O programa não consegue validar automaticamente as regras esportivas de todo mercado personalizado.

### Estatísticas esportivas

O importador aceita o formato de exportação FootyStats com nomes `*-matches-AAAA-to-AAAA-stats.csv`. O arquivo [de exemplo](examples/demo-sports-matches-2026-to-2027-stats.csv) é sintético e pode ser redistribuído como parte desta demonstração.

Arquivos `teams`, `teams2` e `players` ficam armazenados como agregados de temporada. Últimos 5/10 jogos são calculados exclusivamente com partidas concluídas de `matches`. Para outros conjuntos, confira os direitos de uso e redistribuição da fonte.

## Limitações

- Frequência de uma amostra pequena e consenso sem margem não demonstram vantagem futura. Não há modelo preditivo validado ou backtest fora da amostra.
- O painel não multiplica probabilidades de seleções correlacionadas para estimar uma múltipla.
- A ausência de um campo no CSV impede a análise daquela estatística; não há preenchimento artificial.
- Os adaptadores externos são verificados com mocks. Disponibilidade, cobertura e comportamento atual das APIs reais não foram verificados nesta versão.
- A aplicação é local e de usuário único, sem autenticação. O servidor vincula-se a `127.0.0.1`. Não é uma configuração pronta para hospedagem pública.
- Não é uma certificação jurídica de uso ou publicação de funcionalidades operacionais.

## Configuração opcional

Copie `.env.example` para `.env` para alterar `PORT`, `DB_PATH` ou `SEED_DEMO`. O banco padrão é `data/portfolio-demo.db`, separado do arquivo utilizado na versão original. Use `SEED_DEMO=false` para iniciar sem os exemplos em um banco novo.

Não utilize uma cópia do seu banco pessoal nesta demonstração. `.env`, bancos, caches e dependências estão excluídos pelo `.gitignore`.

## Autor

**Bruno Deguti** — estudante de Análise e Desenvolvimento de Sistemas.

[LinkedIn](https://www.linkedin.com/in/bruno-deguti-00b09472/) · [GitHub](https://github.com/brunodeguti)
