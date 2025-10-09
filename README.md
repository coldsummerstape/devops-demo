# DevOps Demo: NestJS + Redis + Kubernetes with CI/CD

This repository contains a minimal NestJS service that checks connectivity to Redis and exposes a health endpoint. It is packaged with a multi‑stage Dockerfile, deployed to Kubernetes via Helm, and released through a GitHub Actions CI/CD pipeline. Optional monitoring (Prometheus/Grafana) and logging (Loki/Promtail) stacks are included in the umbrella chart.

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
    - App: `devops-demo.local`
    - Grafana: `grafana.devops-demo.local`

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
- Grafana datasources: Prometheus (default), Alertmanager, Loki; Grafana Ingress `grafana.devops-demo.local`
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
helm upgrade --install devops-demo ./charts/stack \
  -n devops-test \
  -f ./charts/stack/values.yaml
```

Alternative: install packaged OCI chart (after CI publishes)

```bash
export HELM_EXPERIMENTAL_OCI=1
helm registry login ghcr.io -u <github_user> --password-stdin <<< "$GITHUB_TOKEN"
helm upgrade --install devops-demo oci://ghcr.io/<owner>/charts/devops-demo \
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
kubectl port-forward -n devops-test svc/devops-demo 3000:3000
curl http://localhost:3000/redis
```

Ingress (with DNS/hosts configured):

```bash
curl http://devops-demo.local/redis
```

6) Access Grafana

```bash
kubectl get ingress -n devops-test
# Open http://grafana.devops-demo.local
```

## Local Development

```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
npm ci
npm run start:dev
curl http://localhost:3000/redis
```

Docker build & run locally:

```bash
docker build -t devops-demo:local .
docker run --rm -p 3000:3000 \
  -e REDIS_HOST=host.docker.internal -e REDIS_PORT=6379 \
  devops-demo:local
```

## Configuration

- `REDIS_HOST` (default set by chart to `<release>-redis-master`)
- `REDIS_PORT` (default 6379)
- `REDIS_DB` (default 0)
- `REDIS_PASSWORD` (from Kubernetes Secret/Bitnami Redis)
- `PORT` (default 3000)

## Security

- Non‑root containers, read‑only root filesystem, drop ALL capabilities, no privilege escalation
- Trivy scan enforced (CRITICAL severity fails build)
- Optional Cosign image signing

## Success Criteria

- Application deploys to Kubernetes, `/redis` returns status
- Dockerfile is optimized and works
- CI/CD builds, scans, publishes, deploys
- Documentation enables reproduction

