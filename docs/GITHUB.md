# Publicar no GitHub

Esta entrega contém os arquivos preparados. Nenhum repositório remoto foi criado ou publicado automaticamente.

Sugestão de nome: `bet-scanner-sports-data-lab`.

Sugestão de descrição:

> Laboratório offline de análise esportiva e simulações matemáticas com Node.js, Express, SQLite e importação CSV.

Topics sugeridos: `nodejs`, `express`, `sqlite`, `javascript`, `sports-analytics`, `data-analysis`, `csv`, `portfolio`.

## Passos

1. Extraia o ZIP e abra um terminal na pasta que contém `package.json`.
2. Execute `npm ci` e `npm run check` com Node.js 24 ou superior.
3. Explore a aplicação com `npm start`.
4. Crie um repositório vazio na sua conta do GitHub. Não inicialize outro README remoto se for seguir os comandos abaixo.
5. Inicialize o repositório local e confira os arquivos antes do commit:

```bash
git init
git branch -M main
git add .
git status --short
git diff --cached --stat
```

O `.gitignore` exclui `.env`, `data`, bancos SQLite e `node_modules`. Confira especialmente que esses arquivos não aparecem no staging. Se estiver aproveitando um repositório já existente, arquivos previamente rastreados e commits antigos precisam de revisão adicional: `.gitignore` não apaga o histórico.

Depois da conferência:

```bash
git commit -m "Prepare offline sports analytics portfolio demo"
git remote add origin https://github.com/brunodeguti/bet-scanner-sports-data-lab.git
git push -u origin main
```

A URL acima pressupõe que você criou o repositório com o nome sugerido; ajuste se escolher outro. O push pode solicitar autenticação do GitHub.

O GitHub armazena o código e executa os testes do workflow. GitHub Pages não executa este servidor Express com SQLite. Esta entrega foi preparada para demonstração local, não para hospedagem pública.

Não foi adicionada uma licença de código aberto automaticamente. Escolha uma antes de conceder permissões explícitas de redistribuição do projeto.

## Atualizar uma instalação anterior

Para testar esta revisão, extraia a nova versão em outra pasta e execute `npm ci` e `npm start`. Encerre o servidor anterior antes de iniciar outro na porta 3000. O banco pessoal não está incluído no ZIP; mantenha a pasta anterior se quiser preservar o histórico dos seus testes. Não publique a pasta `data`.
