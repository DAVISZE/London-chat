# London Family Tracker

Aplicação responsiva/PWA para o grupo da família, conversas ao vivo, localização opt-in e chamadas de áudio LiveKit. A tela segue a referência visual recebida. O `.env` não contém credenciais reais; o Firebase será ativado quando os dados do aplicativo Web forem fornecidos.

## Rodar localmente

Requer Node.js 22+ e npm.

```sh
npm install
Copy-Item .env.example .env
npm run dev
```

Preencha o `.env` com o `firebaseConfig` do aplicativo Web no Console Firebase. Os campos `VITE_*` são configurações públicas do cliente Firebase, não chaves administrativas. Nunca coloque service account, segredo LiveKit ou token de acesso no `.env` do frontend.

Para entrar, habilite **Authentication → Sign-in method → Anonymous** e crie um banco **Cloud Firestore**. A tela pede primeiro só a senha familiar; quando ela for aceita, pede o nome. O Firebase cria uma identidade anônima temporária, sem e-mail ou conta individual. A senha continua sendo validada pelo backend e protegida por limite de tentativas. Aplique as regras e índices:

```sh
npx firebase-tools login
npx firebase-tools use <PROJECT_ID>
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

Depois que a pessoa informa a senha e o nome, o backend valida o acesso, cria a sessão e associa a identidade anônima aos cinco grupos usando Firebase Admin. O navegador não pode editar membros. Não é necessário rodar `seed:groups` para o fluxo normal. Como a identidade é temporária, o nome digitado identifica as mensagens e localizações, mas não comprova a identidade civil da pessoa.

## Áudio LiveKit

O cliente usa o SDK oficial `livekit-client`/WebRTC, com DTX, RED, microfone otimizado pelo navegador e controles de conexão. Há chamadas para o grupo ativo e chamadas individuais entre membros. O servidor em `server/index.js` valida o ID token do Firebase, confirma a associação ao grupo e emite um token LiveKit de curta duração. O segredo LiveKit fica somente no backend.

O arquivo local `server/.env` é ignorado pelo Git; mantenha nele os valores do **Server URL**, da **API Key** e da **API Secret** do LiveKit Cloud, nas variáveis `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`. O servidor carrega esse arquivo diretamente com `dotenv`. Configure também `FIREBASE_PROJECT_ID`; para autenticar o Firebase Admin localmente, use `GOOGLE_APPLICATION_CREDENTIALS` apontando para uma credencial mantida fora do repositório.

Configure `FAMILY_ACCESS_PASSWORD` diretamente em `server/.env` com a senha compartilhada escolhida por você. Ela não está no frontend, no banco, nem no `.env.example`; o backend compara em tempo constante e não registra o valor. `FAMILY_SESSION_SECRET` é um segredo aleatório independente, já gerado localmente neste projeto; para girá-lo depois, gere outro no próprio computador (por exemplo, `openssl rand -hex 32`). O servidor cria uma sessão assinada em cookie `HttpOnly`, `Secure` em produção e `SameSite=None` para a origem separada do GitHub Pages. A sessão dura oito horas. Tentativas são limitadas no Firestore (5 por conta ou 20 por IP a cada 15 minutos); os identificadores de limite são HMAC, sem salvar o IP em texto puro.

É necessário hospedar `server/` em um backend confiável (por exemplo Cloud Run ou serviço equivalente) e manter nele:

```text
PORT=3000
FIREBASE_PROJECT_ID=<PROJECT_ID>
LIVEKIT_URL=wss://<seu-projeto>.livekit.cloud
LIVEKIT_API_KEY=<server-side-api-key>
LIVEKIT_API_SECRET=<server-side-api-secret>
FAMILY_ACCESS_PASSWORD=<configured privately in the backend>
FAMILY_SESSION_SECRET=<random backend-only secret>
ALLOWED_ORIGINS=https://<usuario>.github.io
```

Autenticação do Firebase Admin deve usar a identidade de serviço gerenciada do backend (recomendado) ou um segredo de ambiente protegido. Guarde `FAMILY_ACCESS_PASSWORD`, `FAMILY_SESSION_SECRET`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` no Secret Manager do backend. Não inclua chave JSON no frontend ou Git. A URL LiveKit deve apontar para a região mais próxima dos participantes; para chamadas consistentes em rede móvel, escolha projeto/região próximos à família e habilite TURN/relay no serviço. Confirme conectividade real 4G/5G e permissões de microfone em iPhone antes de contar com o serviço. O navegador não permite que esta preparação garanta latência ou disponibilidade. O site estático do GitHub Pages sozinho não pode emitir tokens.

Rode o backend com `npm run server` (porta 3000) e o frontend com `npm run dev`. O proxy de desenvolvimento cobre `/api` quando `VITE_API_BASE_URL` estiver vazio; alternativamente, configure `VITE_API_BASE_URL=http://localhost:3000` no `.env` da raiz. Para produção, configure a URL pública do backend como variável `VITE_API_BASE_URL` no GitHub Actions. Em hospedagem separada, cadastre a origem exata do site em `ALLOWED_ORIGINS` no ambiente privado do backend. Para iPhone/Safari, prefira frontend e API em subdomínios do mesmo domínio personalizado; políticas contra cookies de terceiros podem bloquear sessões entre `github.io` e o domínio do backend.

Verifique a configuração sem revelar valores em `http://localhost:3000/health`: retorna `status: "ok"` quando está pronta ou uma lista `missing` com apenas os nomes das variáveis ausentes. Para testar, tente primeiro uma senha errada; depois entre com a senha correta e informe seu nome quando solicitado. Confira que o arquivo local continua ignorado com `git check-ignore server/.env` depois de inicializar/clonar o repositório.

## Publicar no GitHub Pages

1. Envie este repositório para GitHub com branch `main`.
2. Em **Settings → Pages**, selecione **GitHub Actions** como fonte.
3. Em **Settings → Secrets and variables → Actions → Variables**, cadastre as variáveis `VITE_FIREBASE_*` e `VITE_API_BASE_URL` usadas pelo workflow em `.github/workflows/pages.yml`.
4. Habilite o domínio do GitHub Pages em **Authentication → Settings → Authorized domains** no Firebase.
5. Publique regras/índices Firestore e o backend separado antes de testar login, chat, localização e chamadas.

O PWA funciona em primeiro plano. No iPhone, instale pelo Safari usando **Compartilhar → Adicionar à Tela de Início**. A página não promete execução de chamadas ou localização quando fechada/em segundo plano; notificações FCM e armazenamento de tokens ainda precisam de configuração e implementação. O manifesto e o service worker fornecem instalação e cache básico.

## Estado desta entrega

- **Preparado e implementado no frontend:** layout responsivo/PWA, mapa OSM escuro, entrada com senha compartilhada e nome usando identidade anônima do Firebase, mensagens Firestore em tempo real, encaminhamento para Chateiros, seletor de grupo e consentimento explícito para compartilhar posição atual. O mapa só cria marcadores a partir de documentos reais autorizados no Firestore; sem documentos, não inventa posições.
- **Preparado, depende de credenciais/infraestrutura:** conectar Firebase, aplicar regras, formar grupos, servir o backend autenticado, preencher a senha familiar em `server/.env` e configurar LiveKit. Sem isso, chamadas não conectam.
- **Ainda por implementar:** notificações FCM completas, convites/permissões administrativas dentro do produto, tela de detalhes para voo, limpeza/expiração automática de localização e testes reais de chamada em iPhone e redes 4G/5G. O estado online atual é o último registro enviado, não um sinal confiável de presença em segundo plano.

Os mapas usam blocos raster do OpenStreetMap em HTTPS, sem API key; o mapa precisa de internet e deve respeitar a política de uso dos blocos e manter a atribuição visível.
