import * as pulumi from "@pulumi/pulumi";

// Akka Cloud Platform (acp) prefix for all names
const namePrefix = `acp-${pulumi.getStack()}`;

export function name(suffix: string): string {
  return `${namePrefix}-${suffix}`;
}