import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";
import * as path from "path";

const config = new pulumi.Config();

const grafanaPassword =
    config.requireSecret("grafanaAdminPassword");

const chartVersion =
    config.require("monitoringChartVersion");

// Namespace for monitoring components.
const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: {
        name: "monitoring",
    },
});

// Redis exporter exposes Redis statistics to Prometheus.
const redisLabels = {
    app: "guestbook-redis-exporter",
};

const redisExporter = new k8s.apps.v1.Deployment(
    "guestbook-redis-exporter",
    {
        metadata: {
            namespace: monitoringNamespace.metadata.name,
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: redisLabels,
            },
            template: {
                metadata: {
                    labels: redisLabels,
                },
                spec: {
                    containers: [
                        {
                            name: "redis-exporter",
                            image: "oliver006/redis_exporter:v1.67.0",
                            env: [
                                {
                                    name: "REDIS_ADDR",
                                    value:
                                        "redis://redis-leader.default.svc.cluster.local:6379",
                                },
                            ],
                            ports: [
                                {
                                    name: "metrics",
                                    containerPort: 9121,
                                },
                            ],
                            resources: {
                                requests: {
                                    cpu: "25m",
                                    memory: "32Mi",
                                },
                                limits: {
                                    cpu: "100m",
                                    memory: "128Mi",
                                },
                            },
                        },
                    ],
                },
            },
        },
    },
);

const redisMetricsService = new k8s.core.v1.Service(
    "guestbook-redis-metrics",
    {
        metadata: {
            name: "guestbook-redis-metrics",
            namespace: monitoringNamespace.metadata.name,
        },
        spec: {
            selector: redisLabels,
            ports: [
                {
                    name: "metrics",
                    port: 9121,
                    targetPort: "metrics",
                },
            ],
        },
    },
    {
        dependsOn: [redisExporter],
    },
);

// Blackbox exporter checks frontend HTTP availability and duration.
const blackboxConfig = new k8s.core.v1.ConfigMap(
    "guestbook-blackbox-config",
    {
        metadata: {
            namespace: monitoringNamespace.metadata.name,
        },
        data: {
            "blackbox.yml": `
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      preferred_ip_protocol: ip4
`,
        },
    },
);

const blackboxLabels = {
    app: "guestbook-blackbox-exporter",
};

const blackboxExporter = new k8s.apps.v1.Deployment(
    "guestbook-blackbox",
    {
        metadata: {
            namespace: monitoringNamespace.metadata.name,
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: blackboxLabels,
            },
            template: {
                metadata: {
                    labels: blackboxLabels,
                },
                spec: {
                    containers: [
                        {
                            name: "blackbox-exporter",
                            image:
                                "quay.io/prometheus/blackbox-exporter:v0.26.0",
                            args: [
                                "--config.file=/config/blackbox.yml",
                            ],
                            ports: [
                                {
                                    name: "http",
                                    containerPort: 9115,
                                },
                            ],
                            volumeMounts: [
                                {
                                    name: "config",
                                    mountPath: "/config",
                                    readOnly: true,
                                },
                            ],
                            resources: {
                                requests: {
                                    cpu: "25m",
                                    memory: "32Mi",
                                },
                                limits: {
                                    cpu: "100m",
                                    memory: "128Mi",
                                },
                            },
                        },
                    ],
                    volumes: [
                        {
                            name: "config",
                            configMap: {
                                name: blackboxConfig.metadata.name,
                            },
                        },
                    ],
                },
            },
        },
    },
);

const blackboxService = new k8s.core.v1.Service(
    "guestbook-blackbox",
    {
        metadata: {
            name: "guestbook-blackbox",
            namespace: monitoringNamespace.metadata.name,
        },
        spec: {
            selector: blackboxLabels,
            ports: [
                {
                    name: "http",
                    port: 9115,
                    targetPort: "http",
                },
            ],
        },
    },
    {
        dependsOn: [blackboxExporter],
    },
);

// Install Prometheus, Grafana, and Kubernetes resource monitoring.
const monitoring = new k8s.helm.v3.Release(
    "monitoring-stack",
    {
        name: "monitoring",
        namespace: monitoringNamespace.metadata.name,
        chart: "kube-prometheus-stack",
        version: chartVersion,
        repositoryOpts: {
            repo: "https://prometheus-community.github.io/helm-charts",
        },
        timeout: 900,
        values: {
            grafana: {
                sidecar: {
                    dashboards: {
                        enabled: true,
                        label: "grafana_dashboard",
                        labelValue: "1",
                     },
                },
                adminUser: "admin",
                adminPassword: grafanaPassword,
                service: {
                    type: "NodePort",
                    nodePort: 32000,
                },
                persistence: {
                    enabled: false,
                },
            },

            // Disable components unnecessary for this local exercise.
            alertmanager: {
                enabled: false,
            },
            kubeControllerManager: {
                enabled: false,
            },
            kubeScheduler: {
                enabled: false,
            },
            kubeEtcd: {
                enabled: false,
            },
            kubeProxy: {
                enabled: false,
            },

            prometheus: {
                prometheusSpec: {
                    retention: "6h",
                    resources: {
                        requests: {
                            cpu: "100m",
                            memory: "256Mi",
                        },
                    },
                    additionalScrapeConfigs: [
                        {
                            job_name: "guestbook-redis",
                            scrape_interval: "15s",
                            static_configs: [
                                {
                                    targets: [
                                        "guestbook-redis-metrics.monitoring.svc.cluster.local:9121",
                                    ],
                                },
                            ],
                        },
                        {
                            job_name: "guestbook-frontend",
                            scrape_interval: "15s",
                            metrics_path: "/probe",
                            params: {
                                module: ["http_2xx"],
                            },
                            static_configs: [
                                {
                                    targets: [
                                        "http://frontend.default.svc.cluster.local",
                                    ],
                                },
                            ],
                            relabel_configs: [
                                {
                                    source_labels: ["__address__"],
                                    target_label: "__param_target",
                                },
                                {
                                    source_labels: ["__param_target"],
                                    target_label: "instance",
                                },
                                {
                                    target_label: "__address__",
                                    replacement:
                                        "guestbook-blackbox.monitoring.svc.cluster.local:9115",
                                },
                            ],
                        },
                    ],
                },
            },
        },
    },
    {
        dependsOn: [
            redisMetricsService,
            blackboxService,
        ],
    },
);

// Access URL requires a local port-forward, configured after deployment.
export const grafanaUrl = "http://localhost:3000";
export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = grafanaPassword;
export const grafanaNodePort = 32000;
export const monitoringRelease = monitoring.name;

const dashboard = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "dashboards", "guestbook.json"),
        "utf8",
    ),
);

delete dashboard.id;
dashboard.uid = "guestbook-provisioned";
dashboard.title = "Guestbook Monitoring (Provisioned)";
dashboard.refresh = "15s";

new k8s.core.v1.ConfigMap("guestbook-dashboard", {
    metadata: {
        namespace: monitoringNamespace.metadata.name,
        labels: {
            grafana_dashboard: "1",
        },
    },
    data: {
        "guestbook.json": JSON.stringify(dashboard),
    },
});