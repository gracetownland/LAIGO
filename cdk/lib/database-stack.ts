// AWS CDK imports for core functionality
import { Stack, StackProps, RemovalPolicy, SecretValue } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";

// AWS service-specific imports
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretmanager from "aws-cdk-lib/aws-secretsmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";

// Local stack imports
import { VpcStack } from "./vpc-stack";

/**
 * DatabaseStack creates and configures the RDS PostgreSQL database infrastructure
 * including secrets management, security groups, and RDS proxy for connection pooling
 */
export class DatabaseStack extends Stack {
  // Database instance for the LAIGO application
  public readonly dbInstance: rds.DatabaseInstance;
  // Secret for admin database credentials
  public readonly secretPathAdmin: secretsmanager.ISecret;
  // Secret for application user credentials
  public readonly secretPathUser: secretsmanager.Secret;
  // Secret for table creator user credentials
  public readonly secretPathTableCreator: secretsmanager.Secret;
  // RDS proxy endpoint for connection pooling
  public readonly rdsProxyEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack, // VPC stack dependency for network configuration
    props?: StackProps,
  ) {
    super(scope, id, props);

    // Create RDS service-linked role if it doesn't exist
    // This role allows RDS to perform actions on behalf of the service
    new cr.AwsCustomResource(this, `${id}-RDSServiceLinkedRoleResource`, {
      onCreate: {
        service: "IAM",
        action: "createServiceLinkedRole",
        parameters: {
          AWSServiceName: "rds.amazonaws.com",
        },
        ignoreErrorCodesMatching: "InvalidInput", // Ignore if role already exists
        physicalResourceId: cr.PhysicalResourceId.of("RDSServiceLinkedRole"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    // Import existing secret containing database admin credentials
    const secret = secretmanager.Secret.fromSecretNameV2(
      this,
      "ImportedSecrets",
      "LAIGOSecrets",
    );

    // Create secrets for different database users with appropriate access levels
    this.secretPathAdmin = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AdminSecret",
      `${id}-LAIGO/credentials/rdsDbCredential`,
    );

    // Secret for application user - used by client applications
    const secretPathUserName = `${id}-LAIGO/userCredentials/rdsDbCredential`;
    this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
      secretName: secretPathUserName,
      description: "Secrets for clients to connect to RDS",
      removalPolicy: RemovalPolicy.DESTROY,
      secretObjectValue: {
        username: SecretValue.unsafePlainText("applicationUsername"), // Placeholder - updated at runtime
        password: SecretValue.unsafePlainText("applicationPassword"), // Placeholder - updated at runtime
      },
    });

    // Secret for table creator user - used for database schema management
    const secretPathTableCreator = `${id}-LAIGO/userCredentials/TableCreator`;
    this.secretPathTableCreator = new secretsmanager.Secret(
      this,
      secretPathTableCreator,
      {
        secretName: secretPathTableCreator,
        description: "Secrets for TableCreator to connect to RDS",
        removalPolicy: RemovalPolicy.DESTROY,
        secretObjectValue: {
          username: SecretValue.unsafePlainText("applicationUsername"), // Placeholder - updated at runtime
          password: SecretValue.unsafePlainText("applicationPassword"), // Placeholder - updated at runtime
        },
      },
    );

    // Custom parameter group for PostgreSQL configuration
    // Enables SSL enforcement for secure database connections
    const parameterGroup = new rds.ParameterGroup(
      this,
      `${id}-rdsParameterGroup`,
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_17_9,
        }),
        description: "Custom parameter group for LAIGO database with SSL enforcement",
        parameters: {
          "rds.force_ssl": "1", // Enable SSL requirement
        },
      },
    );

    // Create the main RDS PostgreSQL database instance
    this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
      vpc: vpcStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // Deploy in private subnets for security
      },
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_9,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON, // ARM-based instance for cost efficiency
        ec2.InstanceSize.MEDIUM,
      ),
      credentials: rds.Credentials.fromUsername(
        secret.secretValueFromJson("DB_Username").unsafeUnwrap(), // Admin username from imported secret
        {
          secretName: this.secretPathAdmin.secretName, // Store admin password in new secret
        },
      ),
      multiAz: false, // Single AZ deployment for cost savings
      allocatedStorage: 100, // Initial storage in GB
      maxAllocatedStorage: 150, // Maximum auto-scaling storage limit
      allowMajorVersionUpgrade: false, // Prevent automatic major version upgrades
      autoMinorVersionUpgrade: true, // Allow automatic minor version upgrades
      backupRetention: Duration.days(7), // Retain backups for 7 days
      deleteAutomatedBackups: true, // Clean up backups when instance is deleted
      deletionProtection: true, // Prevent accidental deletion
      databaseName: "laigo", // Default database name
      publiclyAccessible: false, // Keep database private
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS, // Log retention period
      storageEncrypted: true, // Enable encryption at rest
      monitoringInterval: Duration.seconds(60), // Enhanced monitoring every minute
      parameterGroup: parameterGroup,
    });

    // Configure security group rules for database access
    const dbSecurityGroup = this.dbInstance.connections.securityGroups[0];

    // Allow access from existing private subnets if VPC is being reused
    if (
      vpcStack.privateSubnetsCidrStrings &&
      vpcStack.privateSubnetsCidrStrings.length > 0
    ) {
      vpcStack.privateSubnetsCidrStrings.forEach((cidr) => {
        dbSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(5432), // PostgreSQL default port
          `Allow PostgreSQL traffic from private subnet CIDR range ${cidr}`,
        );
      });
    } else {
      console.log(
        "Deploying with new VPC. No need to add private subnet CIDR ranges to inbound rules of RDS.",
      );
    }

    // Allow database access from anywhere within the VPC
    this.dbInstance.connections.securityGroups.forEach(
      function (securityGroup) {
        securityGroup.addIngressRule(
          ec2.Peer.ipv4(vpcStack.vpcCidrString), // Allow from entire VPC CIDR range
          ec2.Port.tcp(5432),
          "Allow PostgreSQL traffic from VPC",
        );
      },
    );

    // Create IAM role for RDS Proxy to manage database connections
    const rdsProxyRole = new iam.Role(this, `${id}-DBProxyRole`, {
      assumedBy: new iam.ServicePrincipal("rds.amazonaws.com"),
    });

    // Grant permission for RDS Proxy to connect to databases
    rdsProxyRole.addToPolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: ["rds-db:connect"], // Allow database connections
      }),
    );

    // Create RDS Proxy for connection pooling and credential management

    const rdsProxy = this.dbInstance.addProxy(id + "-proxy", {
      secrets: [
        this.secretPathUser!, // Application user credentials
        this.secretPathTableCreator!, // Table creator credentials
        this.secretPathAdmin, // Admin credentials
      ],
      vpc: vpcStack.vpc,
      role: rdsProxyRole,
      securityGroups: this.dbInstance.connections.securityGroups, // Use same security groups as database
      requireTLS: true, // Enable TLS requirement for secure connections
    });

    // Fix for CDK not automatically setting the target group name
    let targetGroup = rdsProxy.node.children.find((child: any) => {
      return child instanceof rds.CfnDBProxyTargetGroup;
    }) as rds.CfnDBProxyTargetGroup;

    targetGroup.addPropertyOverride("TargetGroupName", "default");

    // Grant the proxy role permission to connect to the database instance
    this.dbInstance.grantConnect(rdsProxyRole);

    // Store the proxy endpoint for use by other stacks
    this.rdsProxyEndpoint = rdsProxy.endpoint;
  }
}
