import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApiGatewayStack } from "../lib/api-stack";
import { DatabaseStack } from "../lib/database-stack";
import { VpcStack } from "../lib/vpc-stack";

const testEnv = { account: "111122223333", region: "us-east-1" };

function synthApiStack() {
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
  return { app, api };
}

interface CfnResource {
  Type: string;
  Properties?: {
    Name?: string;
    Value?: string;
    PolicyDocument?: {
      Statement?: Array<{
        Action?: string | string[];
        Resource?: string | string[];
      }>;
    };
  };
}

function findSsmParameter(
  template: Template,
  name: string,
): CfnResource["Properties"] | undefined {
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  for (const res of Object.values(resources)) {
    if (
      res.Type === "AWS::SSM::Parameter" &&
      res.Properties?.Name === name
    ) {
      return res.Properties;
    }
  }
  return undefined;
}

describe("ApiGatewayStack Bedrock Sonnet 4.6 cross-region inference", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    const { api } = synthApiStack();
    template = Template.fromStack(api);
  });

  test("BedrockLLMParameter default is Claude Sonnet 4.6 cross-region inference profile", () => {
    const props = findSsmParameter(template, "/TestApiStack/LAIGO/BedrockLLMId");
    expect(props?.Value).toBeDefined();
    expect(String(props!.Value)).toMatch(
      /inference-profile\/us\.anthropic\.claude-sonnet-4-6/,
    );
  });

  test("Bedrock model options SSM JSON includes Claude Sonnet 4.6 and Llama entries", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    expect(props?.Value).toBeDefined();
    const opts = JSON.parse(props!.Value!) as Array<{
      label: string;
      value: string;
      constraints: {
        maxOutputTokens: number;
        defaultMaxOutputTokens: number;
        temperatureRange: number[];
        topPRange: number[];
      };
    }>;
    expect(opts).toHaveLength(2);
    expect(opts.map((o) => o.label)).toEqual([
      "Claude Sonnet 4.6",
      "Llama 3 70b Instruct",
    ]);
    expect(opts[0].value).toMatch(
      /inference-profile\/us\.anthropic\.claude-sonnet-4-6/,
    );
    expect(opts[0].constraints.maxOutputTokens).toBe(8192);
    expect(opts[0].constraints.defaultMaxOutputTokens).toBe(4096);
    expect(opts[1].value).toBe("meta.llama3-70b-instruct-v1:0");
    expect(opts[1].constraints.maxOutputTokens).toBe(8192);
    expect(opts[1].constraints.defaultMaxOutputTokens).toBe(2000);
  });

  test("Bedrock IAM policy allows foundation models and cross-region inference profiles", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ]),
            Resource: Match.arrayWith([
              Match.stringLikeRegexp("foundation-model/\\*"),
              "arn:aws:bedrock:*::inference-profile/*",
            ]),
          }),
        ]),
      },
    });
  });
});
