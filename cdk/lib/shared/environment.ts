import { Construct } from "constructs";

/**
 * Reads the `Environment` context variable and returns whether the deployment
 * targets production. Used across stacks to gate cost-sensitive features.
 *
 * @param scope - Any CDK construct (typically `this` inside a Stack constructor)
 * @returns true if the environment context is set to "production" (case-insensitive)
 */
export function isProdEnvironment(scope: Construct): boolean {
  const env = scope.node.tryGetContext("Environment") as string | undefined;
  return env?.toLowerCase() === "production";
}

/**
 * Returns the environment name from CDK context.
 * Defaults to "development" if not set or empty.
 *
 * @param scope - Any CDK construct (typically `this` inside a Stack constructor)
 * @returns The environment name string
 */
export function getEnvironmentName(scope: Construct): string {
  const env = scope.node.tryGetContext("Environment") as string | undefined;
  return env && env.trim().length > 0 ? env : "development";
}
