# Guestbook Monitoring with Pulumi

Deploys the Pulumi Kubernetes Guestbook application with Prometheus,
Grafana, a Redis exporter, and a Blackbox exporter.

Based on:
https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple

## Prerequisites

- Docker Desktop running Linux containers
- Minikube
- kubectl
- Node.js and npm
- Pulumi CLI
- At least 4 CPUs and 6 GiB available for Minikube

Commands below use PowerShell. Run them from the project directory.

## Deploy

Start the local Kubernetes cluster:

```powershell
minikube start --driver=docker --cpus=4 --memory=6144
kubectl config use-context minikube
kubectl get nodes
```

Install dependencies:

```powershell
npm ci
```

Configure a new Pulumi stack:

```powershell
pulumi login --local
pulumi stack init dev
pulumi config set isMinikube true
pulumi config set monitoringChartVersion 92.16.1
pulumi config set --secret grafanaAdminPassword
```

Choose a Grafana password at the value prompt. The Pulumi stack
passphrase protects encrypted configuration and is separate from the
Grafana password. Keep both available for subsequent commands.

If the stack already exists, use `pulumi stack select dev` instead
of initializing it again.

Validate and deploy:

```powershell
npx tsc --noEmit
pulumi preview
pulumi up
```

Approve the update when prompted.

## Access the Guestbook

Run in a separate terminal and leave it running:

```powershell
kubectl port-forward -n default service/frontend 8080:80
```

Open http://localhost:8080, submit a message, and confirm it appears.

## Access Grafana

Grafana is exposed as a NodePort service on port 32000.

For convenient local access, run in a separate terminal:

```powershell
kubectl port-forward -n monitoring service/monitoring-grafana 3000:80
```

Open http://localhost:3000.

- Admin username: `admin`
- Admin password: the value configured during deployment

Retrieve the credentials from Pulumi:

```powershell
pulumi stack output grafanaAdminUser
pulumi stack output grafanaAdminPassword --show-secrets
```

The password output is secret and is hidden during normal deployment
output. Do not commit plaintext passwords or your stack passphrase.

The `grafanaUrl` output points to the local port-forward URL and
requires that port-forward to be running.

Alternatively, access the NodePort through Minikube:

```powershell
minikube service monitoring-grafana -n monitoring --url
```

Use the URL printed by Minikube. If it starts a tunnel, leave that
terminal running.

If port 3000 is occupied, reuse the existing Grafana port-forward
or use `3001:80` and open http://localhost:3001.

## Verify Prometheus Scraping

Run in a separate terminal:

```powershell
kubectl port-forward -n monitoring service/monitoring-kube-prometheus-prometheus 9090:9090
```

Open http://localhost:9090/targets.

Confirm these scrape jobs are UP:

- `guestbook-frontend`
- `guestbook-redis`

In the Prometheus query page, execute:

```promql
probe_success{job="guestbook-frontend"}
```

Expected value: `1`, indicating the frontend HTTP probe succeeded.

```promql
redis_up{job="guestbook-redis"}
```

Expected value: `1`, indicating the exporter can connect to Redis.

Additional metrics:

```promql
probe_duration_seconds{job="guestbook-frontend"}
```

```promql
redis_memory_used_bytes{job="guestbook-redis"}
```

A scrape target being UP confirms Prometheus can scrape the exporter.
The application-specific queries above separately verify frontend
probe success and Redis connectivity.

## Provisioned Dashboard

Open Grafana → Dashboards → Guestbook Monitoring (Provisioned).

Direct link:
http://localhost:3000/d/guestbook-provisioned

The dashboard contains:

- Frontend availability
- Redis availability
- Frontend HTTP probe duration
- Redis memory usage

The dashboard JSON is stored in `dashboards/guestbook.json`.
Pulumi creates a labeled ConfigMap, and the Grafana dashboard sidecar
loads it automatically. No manual dashboard import is required.

## Monitoring Design

Prometheus and Grafana are deployed using the
`kube-prometheus-stack` Helm chart through Pulumi.

Prometheus scrapes the following jobs every 15 seconds:

- Frontend: Blackbox exporter performs an HTTP probe against
  `frontend.default.svc.cluster.local`.
- Backend: Redis exporter collects metrics from the
  `redis-leader` service.

The frontend image does not expose native Prometheus application
metrics, so this implementation measures synthetic HTTP availability
and probe duration. It does not measure real user request counts or
application error rates.

Redis memory is measured directly through the Redis exporter.
The dedicated Redis scrape monitors the leader; it does not separately
monitor the replica.

## Project Files

- `index.ts`: Guestbook deployments, services, and stack exports
- `monitoring.ts`: Monitoring Helm release, exporters, scrape
  configuration, and dashboard ConfigMap
- `dashboards/guestbook.json`: Grafana dashboard definition
- `Pulumi.yaml`: Pulumi project configuration
- `package.json` and `package-lock.json`: Node.js dependencies
- `tsconfig.json`: TypeScript configuration

## Validation

Validated locally with Docker Desktop and Minikube:

- TypeScript compilation completed without errors.
- Guestbook accepted and displayed a message.
- Monitoring pods were ready and running.
- Both Guestbook scrape targets were UP.
- Frontend probe success and Redis connectivity returned `1`.
- All four provisioned dashboard panels displayed data.
- A subsequent Pulumi preview reported 15 unchanged resources.

## Limitations

This is a local demonstration deployment.

- Grafana persistence is disabled. The provisioned dashboard is
  restored from code, but manual Grafana changes may be lost.
- Prometheus retention is six hours, with no persistent volume
  configured.
- Alertmanager is disabled.
- Exporter image versions and the monitoring Helm chart are pinned.
- Production use would require durable storage, TLS, access controls,
  alerting, and further application instrumentation.

## Cleanup

To remove the resources managed by this project:

```powershell
pulumi destroy
```

Approve only when you are ready to remove the application and
monitoring resources.

To stop the local cluster afterward:

```powershell
minikube stop
```