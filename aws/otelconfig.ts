import yaml = require("js-yaml");
import * as fs from "fs";

export const awsOTelCollectorConfigFileName = "aws-otel-collector-config.yaml";

const awsOTelCollectorConfig = yaml.load(fs.readFileSync(awsOTelCollectorConfigFileName).toString()) as OTelConfig;

class AwsOTelCollectorConfig {
  public zipkinPort: number = parseConfigPort(
    awsOTelCollectorConfig.receivers?.zipkin?.endpoint,
    "receivers.zipkin.endpoint",
  );
  public healthCheckPort: number = parseConfigPort(
    awsOTelCollectorConfig.extensions?.health_check?.endpoint,
    "extensions.health_check.endpoint",
  );
}

export function getAwsOTelCollectorConfig(): AwsOTelCollectorConfig {
  return new AwsOTelCollectorConfig();
}

export function readAwsOTelCollectorConfig(): string {
  return fs.readFileSync(awsOTelCollectorConfigFileName).toString();
}

interface Endpoint {
  endpoint: string | undefined;
}

interface Receivers {
  zipkin: Endpoint | undefined;
  jaeger: Endpoint | undefined;
}

interface Extensions {
  health_check: Endpoint | undefined;
}

interface OTelConfig {
  receivers: Receivers | undefined;
  extensions: Extensions | undefined;
}

function parseConfigPort(endpoint: string | undefined, configPath: string): number {
  if (endpoint === undefined) {
    throw new Error(`${awsOTelCollectorConfigFileName} doesn't have '${configPath}' declared!`);
  } else {
    const chunks = endpoint.split(":");
    if (chunks.length != 2) {
      throw new Error(
        `${awsOTelCollectorConfigFileName} has malformed '${configPath}': '${endpoint}'! It must have a 'host:port' format.`,
      );
    }
    const unparsedPort = chunks[1];
    const parsedPort = parseInt(unparsedPort);
    if (isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(
        `${awsOTelCollectorConfigFileName} has malformed '${configPath}' port: '${unparsedPort}'! It must have a number between 0 and 65535.`,
      );
    }
    return parsedPort;
  }
}
