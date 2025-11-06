# Career Autopilot Stack Chart

Umbrella Helm chart that includes the application (via `bjw-s/app-template`), PostgreSQL, Redis, monitoring (Prometheus/Grafana), logging (Loki/Promtail), and ingress controller.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+

## Installation

```bash
# Add required Helm repositories
helm repo add bjw-s https://bjw-s-labs.github.io/helm-charts
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# Update dependencies
cd charts/stack
helm dependency update
cd ../..

# Create secrets (required)
kubectl create secret generic career-autopilot-secrets \
  --from-literal=telegram-api-id='YOUR_API_ID' \
  --from-literal=telegram-api-hash='YOUR_API_HASH' \
  --from-literal=telegram-session='YOUR_SESSION' \
  --from-literal=telegram-bot-token='YOUR_BOT_TOKEN' \
  --from-literal=openai-api-key='YOUR_OPENAI_KEY' \
  -n devops-test

# Install the stack
helm install career-autopilot ./charts/stack -n devops-test --create-namespace
```

## Components

- **Application**: Career Autopilot app via `bjw-s/app-template`
- **PostgreSQL**: Bitnami PostgreSQL chart
- **Redis**: Bitnami Redis chart
- **Monitoring**: Prometheus + Grafana
- **Logging**: Loki + Promtail
- **Ingress**: NGINX Ingress Controller

## Configuration

See `values.yaml` for configuration options. The app uses `bjw-s/app-template` which provides a flexible structure for deploying applications.

### Required Secrets

Create a Kubernetes Secret named `career-autopilot-secrets` with:
- `telegram-api-id`
- `telegram-api-hash`
- `telegram-session`
- `telegram-bot-token` (optional)
- `openai-api-key` (optional)

## Access

- Application: `http://career-autopilot.local` (if ingress enabled)
- Grafana: `http://grafana.career-autopilot.local` (if ingress enabled)
- Prometheus: Port-forward to `career-autopilot-kube-prometheus-prometheus:9090`

## Metrics

All components expose Prometheus metrics:
- Application: `/metrics` endpoint (ServiceMonitor enabled)
- PostgreSQL: via Bitnami exporter
- Redis: via Bitnami exporter
- NGINX Ingress: via built-in metrics

ServiceMonitors are automatically configured for Prometheus discovery.
