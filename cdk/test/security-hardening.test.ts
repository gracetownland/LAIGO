import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApiGatewayStack } from "../lib/api-stack";
import { DatabaseStack } from "../lib/database-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { VpcStack } from "../lib/vpc-stack";

const testEnv = { account: "111122223333", region: "us-east-1" };

/**
 * Helper: synthesize the ApiGatewayStack with a production domain configured.
 */
function synthApiStackWithDomain() {
  const app = new cdk.App();
  const vpc = new VpcStack(app, "TestVpc", {
    env: testEnv,
    stackPrefix: "Test",
  });
  const db = new DatabaseStack(app, "TestDb", vpc, { env: testEnv });
  const ecrStack = new cdk.Stack(app, "TestEcr", { env: testEnv });
  const textRepo = new ecr.Repository(ecrStack, "TextGenRepo", {
    repositoryName: "test-laigo-textgen",
  });
  const playgroundRepo = new ecr.Repository(ecrStack, "PlaygroundGenRepo", {
    repositoryName: "test-laigo-playground",
  });

  const api = new ApiGatewayStack(app, "TestApiStack", db, vpc, {
    env: testEnv,
    ecrRepositories: {
      textGeneration: textRepo,
      playgroundGeneration: playgroundRepo,
    },
    domainName: "app.example.com",
  });
  api.addDependency(db);
  return Template.fromStack(api);
}

/**
 * Helper: synthesize the ApiGatewayStack without a domain (development mode).
 */
function synthApiStackWithoutDomain() {
  const app = new cdk.App();
  const vpc = new VpcStack(app, "TestVpc", {
    env: testEnv,
    stackPrefix: "Test",
  });
  const db = new DatabaseStack(app, "TestDb", vpc, { env: testEnv });
  const ecrStack = new cdk.Stack(app, "TestEcr", { env: testEnv });
  const textRepo = new ecr.Repository(ecrStack, "TextGenRepo", {
    repositoryName: "test-laigo-textgen",
  });
  const playgroundRepo = new ecr.Repository(ecrStack, "PlaygroundGenRepo", {
    repositoryName: "test-laigo-playground",
  });

  const api = new ApiGatewayStack(app, "TestApiStack", db, vpc, {
    env: testEnv,
    ecrRepositories: {
      textGeneration: textRepo,
      playgroundGeneration: playgroundRepo,
    },
  });
  api.addDependency(db);
  return Template.fromStack(api);
}

/**
 * Helper: synthesize the DBFlowStack for Migration Lambda assertions.
 */
function synthDbFlowStack() {
  const app = new cdk.App();
  const vpc = new VpcStack(app, "TestVpc", {
    env: testEnv,
    stackPrefix: "Test",
  });
  const db = new DatabaseStack(app, "TestDb", vpc, { env: testEnv });
  const dbFlow = new DBFlowStack(app, "TestDBFlow", vpc, db, { env: testEnv });
  dbFlow.addDependency(db);
  return Template.fromStack(dbFlow);
}

describe("Security Hardening - Migration Lambda TLS (Requirement 1)", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    template = synthDbFlowStack();
  });

  test("NODE_TLS_REJECT_UNAUTHORIZED is absent from Migration Lambda environment", () => {
    // Get all Lambda functions in the template
    const lambdas = template.findResources("AWS::Lambda::Function");
    for (const [logicalId, resource] of Object.entries(lambdas)) {
      const env = (resource as any).Properties?.Environment?.Variables;
      if (env) {
        expect(env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
      }
    }
  });

  test("NODE_EXTRA_CA_CERTS is present in Migration Lambda environment", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          NODE_EXTRA_CA_CERTS: "/opt/rds-ca/global-bundle.pem",
        }),
      },
    });
  });
});

describe("Security Hardening - TextGen Lambda Least Privilege (Requirement 2)", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    template = synthApiStackWithDomain();
  });

  test("TextGen Lambda SM_DB_CREDENTIALS references secretPathUser", () => {
    // The TextGen Lambda has its logical ID overridden to "TextGenLambdaDockerFunc"
    const resources = template.toJSON().Resources;
    const textGenFunc = resources["TextGenLambdaDockerFunc"];
    expect(textGenFunc).toBeDefined();
    expect(textGenFunc.Type).toBe("AWS::Lambda::Function");

    const env = textGenFunc.Properties.Environment.Variables;
    expect(env.SM_DB_CREDENTIALS).toBeDefined();

    // The secret name should contain "userCredentials" (from secretPathUser)
    // and NOT contain "credentials/rdsDbCredential" (admin pattern)
    // secretPathUser name pattern: `${id}-LAIGO/userCredentials/rdsDbCredential`
    const secretRef = env.SM_DB_CREDENTIALS;
    // It could be a Ref or a string - check it references the user secret
    if (typeof secretRef === "string") {
      expect(secretRef).toContain("userCredentials");
    } else {
      // If it's a CloudFormation intrinsic (Ref or Fn::*), verify it doesn't reference admin
      // The user secret is created in the DB stack, so it will be an import
      expect(JSON.stringify(secretRef)).not.toContain("AdminSecret");
    }
  });
});

describe("Security Hardening - API Gateway Data Trace Disabled (Requirement 4)", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    template = synthApiStackWithDomain();
  });

  test("dataTraceEnabled is false in API Gateway stage", () => {
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          DataTraceEnabled: false,
        }),
      ]),
    });
  });
});

describe("Security Hardening - S3 CORS Origins (Requirement 5)", () => {
  jest.setTimeout(300_000);

  test("S3 CORS origins exclude localhost when domainName is provided", () => {
    const template = synthApiStackWithDomain();
    const buckets = template.findResources("AWS::S3::Bucket");

    for (const [logicalId, resource] of Object.entries(buckets)) {
      const corsConfig = (resource as any).Properties?.CorsConfiguration;
      if (corsConfig && corsConfig.CorsRules) {
        for (const rule of corsConfig.CorsRules) {
          if (rule.AllowedOrigins) {
            // Should NOT contain localhost
            expect(rule.AllowedOrigins).not.toContain("http://localhost:5173");
            // Should contain only the production domain
            expect(rule.AllowedOrigins).toContain("https://app.example.com");
          }
        }
      }
    }
  });

  test("S3 CORS origins allow all when no domainName is provided", () => {
    const template = synthApiStackWithoutDomain();
    const buckets = template.findResources("AWS::S3::Bucket");

    let foundCors = false;
    for (const [logicalId, resource] of Object.entries(buckets)) {
      const corsConfig = (resource as any).Properties?.CorsConfiguration;
      if (corsConfig && corsConfig.CorsRules) {
        for (const rule of corsConfig.CorsRules) {
          if (rule.AllowedOrigins) {
            foundCors = true;
            expect(rule.AllowedOrigins).toContain("*");
          }
        }
      }
    }
    expect(foundCors).toBe(true);
  });
});

describe("Security Hardening - WebSocket Stage Throttling (Requirement 8)", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    template = synthApiStackWithDomain();
  });

  test("WebSocket stage has throttle settings (rate=10, burst=20)", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "prod",
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 10,
        ThrottlingBurstLimit: 20,
      }),
    });
  });
});
