# Career Autopilot: Telegram Userbot for Job Vacancies

This repository contains a NestJS application that automatically monitors Telegram channels for job vacancies, parses them using AI, and sends personalized replies to recruiters. It is packaged with a multi‑stage Dockerfile, deployed to Kubernetes via Helm, and released through a GitHub Actions CI/CD pipeline. Optional monitoring (Prometheus/Grafana) and logging (Loki/Promtail) stacks are included in the umbrella chart.

## Repository Structure

```
src/
  redis/redis.service.ts
  app.controller.ts
  app.module.ts
  app.service.ts
  main.ts
charts/
  app/    # simple app+redis chart
  stack/  # umbrella: app template + redis + monitoring + logging + ingress-nginx
```

## Endpoints

- GET `/` → returns "Hello World!"
- GET `/redis` → `{ "status": boolean, "message"?: string }`

## Docker Image

- Multi-stage build (deps → build → prod deps prune → runtime)
- Node 20 Alpine runtime, non‑root user, read‑only root FS
- `NODE_ENV=production`, source maps enabled
- Exposes port 3000; entrypoint `node dist/main.js`

## Helm Charts

- `charts/app`: Application chart with Bitnami Redis dependency
  - Probes (liveness/readiness), resources, autoscaling enabled
  - SecurityContext: non‑root, readOnlyRootFilesystem, drop ALL caps, no privilege escalation
  - ENV wired for Redis host/port/db; password from Secret

- `charts/stack` (umbrella):
  - App via `bjw-s/app-template`
  - Redis via Bitnami chart (auth enabled, metrics enabled with ServiceMonitor)
  - Monitoring: kube‑prometheus‑stack (Prometheus + Grafana)
  - Logging: loki‑stack (Loki + Promtail with NestJS log parsing pipeline)
  - Ingress: ingress‑nginx enabled with metrics and ServiceMonitor
  - Grafana datasources preconfigured (Prometheus default, Alertmanager, Loki)
  - Ingress examples:
    - App: `career-autopilot.local`
    - Grafana: `grafana.career-autopilot.local`

## CI/CD (GitHub Actions)

Workflow: `.github/workflows/release.yml`

- Triggers: pushes to `main/master/feat/*`, semver tags, manual dispatch
- Jobs:
  - test: Node 20/22 matrix, Redis service, lint (non‑blocking), unit+e2e tests, upload JSON reports
  - docker: build+push to GHCR with metadata and cache; Trivy scan fails on CRITICAL; optional Cosign signing
  - helm: deps update, lint, template, package; push chart to GHCR as OCI
  - deploy: kubeconfig from secret, ensure namespace, `helm upgrade --install`, wait for readiness
- Image tags: `latest` on main, semver tags, `sha`, branch refs
- Chart version: tag or `0.1.0-<shortsha>`

Required secrets:

- `KUBECONFIG` — kubeconfig content for target cluster
- `GITHUB_TOKEN` — built‑in, used for GHCR/OCI login
- Optional: `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` for image signing

## Monitoring and Logging

- Prometheus discovers all ServiceMonitor/PodMonitor across namespaces (empty selectors)
- Grafana datasources: Prometheus (default), Alertmanager, Loki; Grafana Ingress `grafana.career-autopilot.local`
- Promtail collects logs from annotated pods, with regex pipeline tailored to NestJS format
- Redis exporter enabled via Bitnami chart

## Installation

Prerequisites: Kubernetes cluster, `kubectl`, `helm`; NGINX ingress if using Ingress. Adjust DNS/hosts for the example domains as needed.

1) Add Helm repos

```bash
helm repo add bjw-s https://bjw-s-labs.github.io/helm-charts
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

2) Create namespace

```bash
kubectl create namespace devops-test
```

3) Install umbrella stack from local sources

```bash
helm upgrade --install career-autopilot ./charts/stack \
  -n devops-test \
  -f ./charts/stack/values.yaml
```

Alternative: install packaged OCI chart (after CI publishes)

```bash
export HELM_EXPERIMENTAL_OCI=1
helm registry login ghcr.io -u <github_user> --password-stdin <<< "$GITHUB_TOKEN"
helm upgrade --install career-autopilot oci://ghcr.io/<owner>/charts/career-autopilot \
  --version <chart-version> \
  -n devops-test
```

4) Verify

```bash
kubectl get pods -n devops-test
kubectl get svc -n devops-test
```

5) Test the API

Port‑forward:

```bash
kubectl port-forward -n devops-test svc/career-autopilot 3000:3000
curl http://localhost:3000/redis
```

Ingress (with DNS/hosts configured):

```bash
curl http://career-autopilot.local/redis
```

6) Access Grafana

```bash
kubectl get ingress -n devops-test
# Open http://grafana.career-autopilot.local
```

## Docker Compose

Полный запуск всех сервисов (PostgreSQL, Redis, приложение) через Docker Compose:

```bash
# 1. Создайте .env файл с необходимыми переменными (см. секцию Telegram Userbot)
# 2. Запустите все сервисы
docker-compose up -d

# Просмотр логов
docker-compose logs -f app

# Остановка и очистка (включая volumes)
docker-compose down -v

# Пересборка после изменений кода
docker-compose build app
docker-compose up -d
```

Для разработки (только PostgreSQL и Redis, приложение запускается локально):

```bash
docker-compose -f docker-compose.dev.yml up -d
npm ci
npm run start:dev
```

## Local Development

Без Docker Compose (только Redis):

```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
npm ci
npm run start:dev
curl http://localhost:3000/redis
```

Docker build & run locally:

```bash
docker build -t career-autopilot:local .
docker run --rm -p 3000:3000 \
  -e REDIS_HOST=host.docker.internal -e REDIS_PORT=6379 \
  career-autopilot:local
```

## Configuration

- `REDIS_HOST` (default set by chart to `<release>-redis-master`, для docker-compose: `redis`)
- `REDIS_PORT` (default 6379)
- `REDIS_DB` (default 0)
- `REDIS_PASSWORD` (from Kubernetes Secret/Bitnami Redis)
- `DB_HOST` (default `localhost`, для docker-compose: `postgres`)
- `DB_PORT` (default 5432)
- `DB_USER` (default `postgres`)
- `DB_PASSWORD` (default `postgres`)
- `DB_NAME` (default `career_autopilot`)
- `DB_SYNC` (default `false`, для dev можно `true` для автоматической синхронизации схемы)
- `DB_LOGGING` (default `false`, включить SQL логи)
- `PORT` (default 3000)
- `TELEGRAM_CHANNEL_IDS` (optional: comma/newline separated channel usernames or numeric IDs to monitor, e.g. `@jobs_channel,-1001234567890`)
- `TELEGRAM_JOB_KEYWORDS` (optional: comma/newline separated keywords the post must contain to trigger an auto-reply)
- `TELEGRAM_REPLY_TEMPLATE` (optional: text to send as reply, supports placeholders `{{ORIGINAL}}`, `{{MENTIONS}}`, `{{LINKS}}`)

<!-- Bot API flow removed; only userbot (MTProto) is supported in this project. -->

## Telegram Userbot (MTProto)

Если бот‑аккаунт не может быть добавлен админом в канал, используйте userbot (ваш личный аккаунт через MTProto). Реализовано на gramJS. Возможности:

- Читает посты каналов, где состоит ваш аккаунт
- Фильтрует по ключевым словам и ограниченному списку каналов
- Отправляет личные сообщения упомянутым пользователям из поста (DM)
- Дедупликация и лимитирование отправок через Redis

Требования:

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — получить на `my.telegram.org`
- `TELEGRAM_SESSION` — строковая сессия пользователя (получить один раз через QR/SMS, затем хранить в Secret)
- Ваш аккаунт подписан на нужные каналы

ENV переменные:

```bash
# Обязательные для userbot
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
TELEGRAM_SESSION=1AQA...  # строка сессии gramJS

# Фильтры/шаблоны
TELEGRAM_CHANNEL_IDS=@jobs_channel,-1001234567890
TELEGRAM_JOB_KEYWORDS=DevOps,Kubernetes
TELEGRAM_REPLY_TEMPLATE=Здравствуйте! Интересует вакансия. {{MENTIONS}} {{LINKS}}

# Ограничения DM
TELEGRAM_DM_MAX=3          # макс. адресатов на один пост
TELEGRAM_DM_DELAY_MS=1500  # задержка между DM, мс
TELEGRAM_DRY_RUN=true      # не отправлять сообщения, только логировать
TELEGRAM_LOG_MESSAGES=true # логировать входящие сообщения из разрешённых каналов
TELEGRAM_LOG_FULL=false    # выводить полный текст (true) или только превью
TELEGRAM_DEBUG=true        # подробные логи пайплайна (allow/keyword/dedup)
TELEGRAM_BACKFILL_ON_START=true   # запустить скан предыдущих постов при старте
TELEGRAM_BACKFILL_LIMIT=50        # сколько сообщений на канал просканировать
TELEGRAM_BACKFILL_SINCE_DAYS=7    # ограничить давность (в днях), опционально

# LLM для персонализации ответов и извлечения полей
LLM_ENABLED=true                   # включить использование LLM
LLM_API_TYPE=openai                # тип API: 'openai' (OpenAI API) или 'ollama' (Ollama)
LLM_ENDPOINT=https://api.openai.com # URL API (для OpenAI оставьте по умолчанию, для Ollama укажите http://ollama:11434)
LLM_MODEL=gpt-4o-mini              # модель для использования (для OpenAI: gpt-4o-mini, gpt-4o, gpt-3.5-turbo; для Ollama: qwen3-vl:latest)
OPENAI_API_KEY=sk-...              # API ключ OpenAI (обязателен если LLM_API_TYPE=openai)
# Примечание: Если LLM настроен (LLM_ENABLED=true, LLM_ENDPOINT и LLM_MODEL указаны),
# LLM автоматически используется как ОСНОВНОЙ метод парсинга вакансий (поддерживает любые форматы сообщений).
# Regex парсинг используется только как fallback, если LLM недоступен или вернул пустой результат.
# LLM_EXTRACT_FIELDS больше не требуется - LLM парсинг включен автоматически при настройке LLM.

# Telegram Bot для управления вакансиями (опционально)
TELEGRAM_BOT_TOKEN=123456:ABC...   # токен бота от @BotFather
TELEGRAM_BOT_ALLOWED_USERS=123456789,987654321  # ID пользователей с доступом (через запятую), если пусто - доступ для всех
```

Замечания по работе:

- Userbot не отвечает в самом канале; он пишет в личку найденным контактам (по `@username` или `t.me/...`).
- Для стабильности используйте Redis (уже подключён) — хранится факт обработки поста на 7 дней.
- Соблюдайте лимиты Telegram, избегайте агрессивной рассылки.
- Для теста без отправки ЛС включите `TELEGRAM_DRY_RUN=true` — бот пройдёт весь пайплайн и залогирует, кому и что "отправил бы".
- Для обработки истории включите `TELEGRAM_BACKFILL_ON_START=true` и настройте лимиты.
- **LLM для извлечения полей**: Если LLM настроен (указаны `LLM_ENABLED=true`, `LLM_ENDPOINT` и `LLM_MODEL`), бот автоматически использует LLM как ОСНОВНОЙ метод парсинга вакансий. LLM анализирует текст вакансий и извлекает структурированные данные (должность, компания, зарплата, локация, формат работы, контакты, технологии) из любых форматов сообщений (русский, английский, смешанный, структурированный или неструктурированный). Если LLM недоступен или не найдёт поле, используется fallback на regex-парсинг. Это решает проблему неоднородных форматов сообщений.

## Telegram Bot для управления вакансиями

Бот для просмотра и управления вакансиями в базе данных. Работает через Bot API (отдельно от userbot).

### Настройка

1. Создайте бота через [@BotFather](https://t.me/BotFather) в Telegram
2. Получите токен бота
3. Добавьте в `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...  # токен от BotFather
   TELEGRAM_BOT_ALLOWED_USERS=123456789  # ваш Telegram user ID (можно узнать у @userinfobot)
   ```

### Команды бота

- `/start` - приветствие и список команд
- `/help` - справка по командам
- `/stats` - общая статистика вакансий
- `/list [статус]` - список вакансий (опционально фильтр по статусу: `processed`, `sent`)
- `/recent [n]` - последние N вакансий (по умолчанию 10)
- `/search <текст>` - поиск по тексту, должности или компании
- `/vacancy <id>` - детальная информация о вакансии

### Инлайн-кнопки

При просмотре вакансии доступны кнопки:
- ✅ Отметить отправленной - изменить статус на `sent`
- ⏳ Вернуть в обработку - вернуть статус `processed`
- 🔄 Обновить - обновить информацию о вакансии
- 🗑 Удалить - удалить вакансию из базы

### Генерация TELEGRAM_SESSION (CLI)

```bash
npm run telegram:session
# Требуется заранее задать:
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
```
Скрипт спросит номер телефона, код и 2FA (если включён), затем выведет строку `TELEGRAM_SESSION`.

## Security

- Non‑root containers, read‑only root filesystem, drop ALL capabilities, no privilege escalation
- Trivy scan enforced (CRITICAL severity fails build)
- Optional Cosign image signing

## Success Criteria

- Application deploys to Kubernetes, `/redis` returns status
- Dockerfile is optimized and works
- CI/CD builds, scans, publishes, deploys
- Documentation enables reproduction
