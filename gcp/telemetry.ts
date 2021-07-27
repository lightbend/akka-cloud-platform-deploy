import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import AdmZip from "adm-zip";

import * as config from "./config";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as gcp from "@pulumi/gcp";

class Dashboard {
  name: string;
  json: string;

  constructor(name: string, json: string) {
    this.name = name;
    this.json = json;
  }

  filename(): string {
    return `${this.name}.json`;
  }
}

export class Backends {
  provider: k8s.Provider;
  cluster: gcp.container.Cluster;

  constructor(provider: k8s.Provider, cluster: gcp.container.Cluster) {
    this.provider = provider;
    this.cluster = cluster;
  }

  install(): void {
    new Grafana().install(this.provider, this.cluster);
    new Prometheus().install(this.provider, this.cluster);
  }
}

class Prometheus {
  install(k8sProvider: k8s.Provider, cluster: gcp.container.Cluster): void {
    new k8s.helm.v3.Chart(
      "prometheus",
      {
        chart: "prometheus",
        fetchOpts: {
          repo: "https://prometheus-community.github.io/helm-charts",
        },
        // Prometheus defaults are good enough for Lightbend Telemetry, so we don't need to customize values here.
        // If you need to change something, you can check the available chart values by running:
        // $ helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
        // $ helm show values prometheus-community/prometheus
      },
      {
        provider: k8sProvider,
        customTimeouts: { create: "30m", update: "30m", delete: "30m" },
        dependsOn: [cluster],
      },
    );
  }
}

class Grafana {
  private static readonly DashboardsFile = `cinnamon-grafana-prometheus-${config.Telemetry.Version}.zip`;
  private static readonly DashboardsUrl = `https://downloads.lightbend.com/cinnamon/grafana/${Grafana.DashboardsFile}`;
  private static readonly DashboardDownloadDir: string = `${path.resolve()}/downloads`;

  private createDashboardDirectory(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const dir = Grafana.DashboardDownloadDir;
      fs.mkdir(dir, { recursive: true }, (err) => {
        if (err) {
          reject(new Error(`Failed to create directory ${dir}. Error: ${err}`));
        } else {
          resolve(dir);
        }
      });
    });
  }

  private downloadDashboards(dir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https.get(Grafana.DashboardsUrl, (response) => {
        if (response.statusCode != 200) {
          reject(new Error(`Expected HTTP Status 200 but got ${response.statusCode}`));
        } else {
          const downloadedFile = `${dir}/${Grafana.DashboardsFile}`;
          const writeStream = fs.createWriteStream(downloadedFile);

          response.pipe(writeStream);
          writeStream.on("finish", () => resolve(downloadedFile));
          response.on("error", (err: Error) => reject(err));
        }
      });
    });
  }

  private getDashboardsFromZip(file: string): Promise<Dashboard[]> {
    return new Promise<Dashboard[]>((resolve, reject) => {
      try {
        const zip = new AdmZip(file);
        const dashboards = zip
          .getEntries()
          .filter((entry) => entry.name.endsWith(".json"))
          .map((entry) => new Dashboard(entry.name.replace(".json", ""), entry.getData().toString("utf8")));
        resolve(dashboards);
      } catch (err) {
        reject(new Error(`Could not read ${file} zip file: ${err}`));
      }
    });
  }

  private getDashboards(): Promise<Dashboard[]> {
    return this.createDashboardDirectory().then(this.downloadDashboards).then(this.getDashboardsFromZip);
  }

  install(k8sProvider: k8s.Provider, cluster: gcp.container.Cluster): Promise<void> {
    return this.getDashboards()
      .then((dashboards) => {
        // This is just a list of the dashboard names/configmaps to later configure
        // the helm chart. It is NOT creating any K8s resources.
        const dashboardsConfigMaps: Record<string, string> = Object.fromEntries(
          dashboards.map((d) => [d.name, d.name]),
        );

        //
        // For each dashboard/ConfigMap, we then need a dashboard provider.
        //
        const dashboardProviders = dashboards.map((dashboard) => {
          return {
            name: dashboard.name,
            orgId: 1,
            folder: "Lightbend Telemetry",
            type: "file",
            disableDeletion: false,
            editable: true,
            options: {
              path: `/var/lib/grafana/dashboards/${dashboard.filename()}`,
            },
          };
        });

        const grafanaChart = new k8s.helm.v3.Chart(
          "grafana",
          {
            chart: "grafana",
            fetchOpts: {
              repo: "https://grafana.github.io/helm-charts",
            },
            values: {
              sidecar: {
                dashboards: {
                  enabled: true,
                  label: "grafana_dashboard",
                },
              },
              // See https://github.com/grafana/helm-charts/blob/main/charts/grafana/README.md#import-dashboards
              dashboardProviders: {
                "dashboardproviders.yaml": {
                  apiVersion: 1,
                  providers: [...dashboardProviders],
                },
              },

              dashboardsConfigMaps: {
                ...dashboardsConfigMaps,
              },

              // See https://github.com/grafana/helm-charts/blob/main/charts/grafana/README.md#sidecar-for-datasources
              datasources: {
                "datasources.yaml": {
                  datasources: [
                    {
                      name: "Cinnamon Prometheus",
                      type: "prometheus",
                      access: "proxy",
                      url: "http://prometheus-server.default.svc.cluster.local",
                      editable: true,
                    },
                  ],
                },
              },
            },
          },
          {
            provider: k8sProvider,
            customTimeouts: { create: "30m", update: "30m", delete: "30m" },
            dependsOn: [cluster],
          },
        );

        //
        // Create ConfigMaps for dashboards. This creates one ConfigMap per dashboard.
        //
        dashboards.forEach((dashboard) => {
          new k8s.core.v1.ConfigMap(
            dashboard.name,
            {
              apiVersion: "v1",
              metadata: {
                name: dashboard.name,
                labels: {
                  grafana_dashboard: "true",
                },
              },
              data: {
                [dashboard.filename()]: dashboard.json,
              },
            },
            {
              provider: k8sProvider,
              dependsOn: [cluster, grafanaChart],
            },
          );
        });

        pulumi.log.info(`Grafana installed with Lightbend Telemetry dashboards.`);
      })
      .catch((reason) => {
        pulumi.log.warn(`Could NOT install Grafana with Lightbend Telemetry dashboards: ${reason}`);
        pulumi.log.warn("Falling back to a vanilla Grafana installation");
        this.simpleInstall(k8sProvider, cluster);
      });
  }

  private simpleInstall(k8sProvider: k8s.Provider, cluster: gcp.container.Cluster): void {
    new k8s.helm.v3.Chart(
      "grafana",
      {
        chart: "grafana",
        fetchOpts: {
          repo: "https://grafana.github.io/helm-charts",
        },
        values: {
          datasources: {
            "datasources.yaml": {
              datasources: [
                {
                  name: "Cinnamon Prometheus",
                  type: "prometheus",
                  access: "proxy",
                  url: "http://prometheus-server.default.svc.cluster.local",
                  editable: true,
                },
              ],
            },
          },
        },
      },
      {
        provider: k8sProvider,
        customTimeouts: { create: "30m", update: "30m", delete: "30m" },
        dependsOn: [cluster],
      },
    );
  }
}
