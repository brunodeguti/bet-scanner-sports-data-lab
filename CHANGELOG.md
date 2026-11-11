# Histórico de alterações

## 1.13.1 — atualização de dependências

- `body-parser`: 2.3.0 → 2.4.0.
- `qs`: 6.16.0 → 6.17.1.
- Correções compatíveis registradas em `package-lock.json`; Express permanece na versão 5.1.0.
- `npm audit`: zero vulnerabilidades conhecidas na consulta de 11/11/2026.
- Os 60 testes passaram após as atualizações.

## 1.13.0 — edição de portfólio

Base: ZIP v1.12.0. O pacote original foi preservado separadamente.

- Demonstração offline com cotações fictícias e 40 partidas sintéticas.
- Consultas externas bloqueadas no servidor, mesmo com chaves no ambiente.
- Importação HTTP de cotações restrita a registros `is_demo=true`.
- Interface de análise esportiva e simulação, com ações externas ocultas.
- Banco padrão separado e escuta restrita a `127.0.0.1`.
- Migração aditiva para a definição de resultados esperados.
- Validação de completude antes do cálculo, prévia e registro de arbitragem ou EV.
- Validação temporal para cotações não demonstrativas.
- Adaptador 1X2 descarta suspensões e registros sem horário conhecido.
- Prazo explícito de 15 segundos nos adaptadores e alocação fixa somente para EV positivo.
- Bloqueio de alterações originadas de outros sites e remoção das chaves do texto principal de erros.
- README, arquitetura, verificação, instruções de publicação e CI atualizados.
- 8 novos testes; 60 testes aprovados no total.

Foram mantidos os módulos de dados, cálculos, importação, histórico e análise por seleção. Não houve migração para outro framework ou reescrita integral.
