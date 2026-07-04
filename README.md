# Lead Finder

App local para procurar leads através de um pipeline de fontes, consolidar os resultados e gerar um CSV compatível com Excel.

## Como usar

1. Executar `start.bat`.
2. Abrir a app em `http://127.0.0.1:41773` quando o browser não abrir automaticamente.
3. Preencher:
   - `O que procurar`: tipo de negócio, por exemplo `barbearias`.
   - `Onde`: país, região ou cidade.
4. Clicar em `Pesquisar`.

Quando a execução terminar, o CSV é descarregado automaticamente.

## O que a app faz

- Divide a procura em várias fontes em paralelo:
  - Pesquisa web
  - Google Maps
  - Redes sociais
  - Diretórios locais
  - Pesquisa livre
- Usa um worker por fonte para descobrir, visitar e extrair dados.
- A fonte de diretórios usa um scraper baseado em `pai.pt` para Páginas Amarelas.
- Cada fonte escreve um CSV parcial e um `response.json` com progresso.
- O master faz agregação e dedupe contínuos enquanto as fontes correm.
- O CSV final é consolidado numa pasta de run e descarregado automaticamente.
- Leads repetidas são fundidas por email, telefone, website ou nome/localidade.
- URLs genéricas de listagens passam para `Fontes consultadas`.
- A execução passa a procurar o máximo possível de leads em cada fonte e termina quando todas acabam.

## Onde a app pesquisa

A app distribui a procura por várias frentes e motores para reduzir bloqueios e alargar a cobertura:

- Pesquisa web
  - `Google`
  - `Bing`
  - `DuckDuckGo`
  - `Yahoo`
  - `Brave`
  - `Mojeek`
  - `Qwant`
- Google Maps
- Redes sociais
- Diretórios locais
  - `pai.pt`
  - `hotfrog.pt`
  - `cylex.pt`
  - `tuugo.pt`
  - `misterwhat.pt`
  - `infobel.com`
  - `paginasamarelas.pt`
- Pesquisa livre
- Seeds diretas quando fazem sentido
  - `ondecortar.pt`
  - `fresha.com`
  - `booksy.com`
  - `agendoor.com`
  - outras fontes públicas relevantes que a tarefa justifique

A pesquisa é feita em paralelo entre fontes, mas cada motor tem pausas próprias para evitar excesso de pedidos seguidos.

## Campos do CSV

O CSV final usa sempre estas colunas:

```csv
Nome;Pagina web;Redes sociais;Email;Telefone;Localidade;Distrito;Fontes consultadas;Observacoes
```

Regras principais:

- `Pagina web`: apenas website oficial ou página própria da empresa.
- `Redes sociais`: Facebook, Instagram ou outra rede social pública relevante.
- `Email` e `Telefone`: contactos públicos.
- `Fontes consultadas`: URLs usadas para validar a lead, incluindo diretórios e listagens.
- `Observacoes`: notas curtas sobre validação, ausência de campos ou limpeza aplicada.

## Ficheiros gerados

Cada execução cria uma pasta em:

```text
runs/run_<data>
```

Dentro dessa pasta podem existir:

- `leads.csv`: CSV final consolidado.
- `request.json`: pedido enviado pela interface.
- `pipeline.log`: log geral da execução.
- `web/leads.csv`: CSV parcial da frente Web oficial.
- `maps/leads.csv`: CSV parcial da frente Google Maps.
- `social/leads.csv`: CSV parcial da frente Redes sociais.
- `directories/leads.csv`: CSV parcial da frente Diretórios locais.
- `free/leads.csv`: CSV parcial da frente Pesquisa livre.
- `task.md`: briefing curto da frente.
- `response.json`: resposta estruturada da frente para o master.

Nem todas as frentes geram sempre CSV. O ficheiro final é criado com tudo o que for válido.

## Requisitos

Ver `requirements.txt`.

Resumo:

- Node.js 18 ou superior.
- Python 3.10 ou superior com `lxml`.
- Windows com `cmd` e PowerShell disponíveis.

O `start.bat` tenta encontrar o Node.js no sistema. Se não estiver no PATH, tenta usar o Node empacotado pelo runtime local do Codex. O Codex CLI deixa de ser necessário para a recolha, mas pode continuar a ser útil mais tarde para revisão assistida.

## Configuração

Valores úteis por variável de ambiente:

- `PORT`: porta HTTP da app. Por defeito, `41773`.
- `HOST`: host HTTP. Por defeito, `127.0.0.1`.
- `WORKER_COMMAND`: executável usado para lançar os workers de recolha. Por defeito, o `node` atual.
- `AGGREGATE_POLL_MS`: intervalo de verificação/consolidação dos CSVs parciais. Por defeito, `1000`.

## Notas

- A app é uma ferramenta de recolha assistida; convém validar os dados antes de os integrar numa base final.
- Os CSVs, respostas parciais e logs ficam guardados em `runs`, além do download automático no fim de cada execução.
- O Excel pode mostrar aviso de possível perda de funcionalidades ao abrir CSV. Isso é normal para ficheiros delimitados por ponto e vírgula.
