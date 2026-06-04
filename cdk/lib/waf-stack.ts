import * as cdk from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { applyStandardTags } from "./shared/tagging";

interface WafStackProps extends cdk.StackProps {
  amplifyAppArn: string;
}

/**
 * WafStack creates a CloudFront-scoped WAF Web ACL and associates it with Amplify
 * MUST be deployed to us-east-1 region for CloudFront compatibility
 */
export class WafStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, props);
    applyStandardTags(this, "WAF");

    // Create CloudFront WAF Web ACL
    const webAcl = new wafv2.CfnWebACL(this, `${id}-cloudfront-waf`, {
      description: "WAF for Amplify CloudFront distribution protection",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "CloudFront-WAF",
      },
      rules: [
        {
          // AWS managed rule set for common web exploits
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet-CloudFront",
          },
        },
        {
          // Rate limiting rule to prevent DDoS attacks
          name: "LimitRequests1000",
          priority: 2,
          action: {
            block: {}, // Block requests exceeding limit
          },
          statement: {
            rateBasedStatement: {
              limit: 1000, // 1000 requests per 5 minutes per IP
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitRequests1000-CloudFront",
          },
        },
      ],
    });

    // Associate WAF with Amplify app
    new wafv2.CfnWebACLAssociation(this, `${id}-WebACLAssociation`, {
      resourceArn: props.amplifyAppArn,
      webAclArn: webAcl.attrArn,
    });

    // Export WAF ARN for reference
    new cdk.CfnOutput(this, "WebAclArn", {
      value: webAcl.attrArn,
      description: "ARN of the CloudFront WAF Web ACL",
      exportName: `${id}-WebAclArn`,
    });
  }
}
